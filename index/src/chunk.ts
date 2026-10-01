import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parse, type Node } from 'acorn'
import { ancestor } from 'acorn-walk'

export const ROOT = join(import.meta.dirname, '..', '..')

/**
 * What gets indexed: the legacy code and its SQL. QUIRKS.md is left out on
 * purpose: it restates every rule in plain words, so indexing it would
 * answer the eval questions for free and say nothing about the code.
 */
export const SOURCES = ['legacy/app.js', 'legacy/server.js', 'legacy/db/schema.sql', 'legacy/db/seed.sql']

export interface Chunk {
  id: string
  file: string
  start: number
  end: number
  kind: 'route' | 'function' | 'constants' | 'sql'
  name: string
  text: string
}

/** Functions longer than this are split into the handlers and functions inside them. */
const MAX_FUNCTION_LINES = 120
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'use'])

type AnyNode = Node & Record<string, unknown>

function routeName(node: AnyNode): string | null {
  if (node.type !== 'CallExpression') return null
  const callee = node.callee as AnyNode
  if (callee.type !== 'MemberExpression') return null
  const object = callee.object as AnyNode
  const property = callee.property as AnyNode
  if (object.type !== 'Identifier' || object.name !== 'app' || property.type !== 'Identifier') return null
  const verb = String(property.name)
  if (!ROUTE_VERBS.has(verb)) return null
  const first = (node.arguments as AnyNode[])[0]
  const path = first?.type === 'Literal' && typeof first.value === 'string' ? first.value : null
  if (verb === 'use') {
    if (path) return `use ${path}`
    const fn = (node.arguments as AnyNode[]).at(-1)
    return fn && Array.isArray(fn.params) && fn.params.length === 4 ? 'error handler' : 'middleware'
  }
  return path ? `${verb.toUpperCase()} ${path}` : null
}

const lineOf = (node: Node) => node.loc!.start.line
const endLineOf = (node: Node) => node.loc!.end.line

/**
 * Splits a JavaScript file along its own structure: one chunk per route
 * handler (`app.post('/x', ...)`), per function, and per run of top-level
 * constants. Each chunk keeps the comment block right above it, since
 * that is where the reasons for a rule tend to live.
 */
export function chunkJs(file: string, source: string): Chunk[] {
  const program = parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true })
  const lines = source.split('\n')
  const spans: Omit<Chunk, 'id' | 'text' | 'file'>[] = []
  const taken: [number, number][] = []
  const oversized: { name: string; start: number; end: number }[] = []
  const inside = (n: Node) => taken.some(([s, e]) => n.start >= s && n.end <= e)

  ancestor(program, {
    CallExpression(node) {
      if (inside(node)) return
      const name = routeName(node as unknown as AnyNode)
      if (!name) return
      spans.push({ start: lineOf(node), end: endLineOf(node), kind: 'route', name })
      taken.push([node.start, node.end])
    },
    FunctionDeclaration(node) {
      if (inside(node)) return
      const length = endLineOf(node) - lineOf(node) + 1
      if (length > MAX_FUNCTION_LINES) {
        oversized.push({ name: node.id?.name ?? 'anonymous', start: lineOf(node), end: endLineOf(node) })
        return
      }
      spans.push({ start: lineOf(node), end: endLineOf(node), kind: 'function', name: node.id?.name ?? 'anonymous' })
      taken.push([node.start, node.end])
    },
  })
  // acorn-walk visits children before parents, so a route inside a small
  // function would win over the function. Re-run with the outer spans first.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: typeof spans = []
  for (const s of spans) if (!kept.some((k) => s.start >= k.start && s.end <= k.end && k !== s)) kept.push(s)

  // An oversized function still has code before its first inner chunk
  // (setup, middleware wiring). That head becomes a chunk of its own.
  for (const f of oversized) {
    const firstInner = Math.min(...kept.filter((k) => k.start > f.start && k.end <= f.end).map((k) => k.start), f.end)
    let end = firstInner - 1
    while (end > f.start && /^\s*(\/\/.*)?$/.test(lines[end - 1] ?? '')) end -= 1
    if (end >= f.start) kept.push({ start: f.start, end, kind: 'function', name: `${f.name} (setup)` })
  }

  // Runs of top-level `var X = ...` statements become one constants chunk.
  let run: Node[] = []
  const flush = () => {
    if (run.length) {
      const names = run.flatMap((d) => ((d as unknown as AnyNode).declarations as AnyNode[]).map((x) => String((x.id as AnyNode).name)))
      kept.push({ start: lineOf(run[0]!), end: endLineOf(run.at(-1)!), kind: 'constants', name: names.join(', ') })
    }
    run = []
  }
  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration' && !(stmt.declarations[0]?.init?.type === 'CallExpression' && (stmt.declarations[0].init.callee as unknown as AnyNode).name === 'require')) run.push(stmt)
    else flush()
  }
  flush()
  kept.sort((a, b) => a.start - b.start)

  return kept.map((s) => {
    // Pull in the comment lines directly above the chunk.
    let start = s.start
    while (start > 1 && /^\s*(\/\/|\/\*|\*)/.test(lines[start - 2] ?? '')) start -= 1
    return { ...s, start, file, id: `${file}:${start}-${s.end}`, text: lines.slice(start - 1, s.end).join('\n') }
  })
}

/** One chunk per SQL statement, with the comments above it. */
export function chunkSql(file: string, source: string): Chunk[] {
  const lines = source.split('\n')
  const chunks: Chunk[] = []
  let start = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (start === 0 && line.trim() !== '') start = i + 1
    if (/;\s*$/.test(line) && start) {
      const text = lines.slice(start - 1, i + 1).join('\n')
      const name = /(CREATE TABLE|INSERT INTO)\s+(?:IF NOT EXISTS\s+)?(\w+)/i.exec(text)
      chunks.push({ id: `${file}:${start}-${i + 1}`, file, start, end: i + 1, kind: 'sql', name: name ? `${name[1]!.toLowerCase()} ${name[2]}` : 'sql', text })
      start = 0
    }
  }
  return chunks
}

export function chunkFile(file: string): Chunk[] {
  const source = readFileSync(join(ROOT, file), 'utf8')
  return file.endsWith('.sql') ? chunkSql(file, source) : chunkJs(file, source)
}

export function chunkLegacy(files: readonly string[] = SOURCES): Chunk[] {
  return files.flatMap((f) => chunkFile(relative(ROOT, join(ROOT, f))))
}
