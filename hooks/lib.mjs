// Shared by the hook scripts. Plain JavaScript on purpose: hooks run on
// every tool call, so they must start fast and need no build step.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parse } from 'yaml'

export async function readInput() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() ? JSON.parse(text) : {}
}

/** The repository being migrated: the session's project, else the working directory. */
export function projectRoot(input) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())
}

/** Repo-relative path with forward slashes, or null when the path is outside the repo. */
export function inRepo(root, file) {
  if (!file) return null
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** Same hash as parity/src/corpus.ts hashFiles (a test keeps the two in step). */
export function hashFiles(root, files) {
  const h = createHash('sha256')
  for (const f of [...files].sort()) h.update(relative(root, f)).update('\0').update(readFileSync(f)).update('\0')
  return h.digest('hex').slice(0, 16)
}

export const serviceHash = (root) => hashFiles(root, walk(join(root, 'service', 'src')))

/** Fingerprint of everything under legacy/, to notice writes no pattern caught. */
export const legacyHash = (root) => (existsSync(join(root, 'legacy')) ? hashFiles(root, walk(join(root, 'legacy'))) : 'none')

/**
 * Splits a shell command into simple commands and their words, honouring
 * quotes and backslashes, so `sed -i 's/a;b/c/' legacy/x` is one command
 * whose last word is `legacy/x`. Redirect targets are returned separately.
 * It is a guardrail, not a shell: `node -e`, `eval` and friends can still
 * write anywhere, which is what the after-command check is for.
 */
export function parseShell(command) {
  const commands = []
  let words = []
  let redirects = []
  let word = ''
  let inWord = false
  let quote = null
  let pendingRedirect = false
  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect) redirects.push(word)
    else words.push(word)
    pendingRedirect = false
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length || redirects.length) commands.push({ words, redirects })
    words = []
    redirects = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      endCommand()
    } else if (c === '>') {
      endWord()
      if (command[i + 1] === '>') i += 1
      if (command[i + 1] === '&') i += 1
      pendingRedirect = true
    } else if (c === '<') {
      endWord()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

const WRITERS = {
  tee: 'args',
  rm: 'args',
  rmdir: 'args',
  mv: 'args',
  touch: 'args',
  truncate: 'args',
  chmod: 'args',
  patch: 'args',
  unlink: 'args',
  cp: 'last',
  install: 'last',
  ln: 'last',
  rsync: 'last',
}

/** Paths a command would write, best effort. */
export function shellWrites(command) {
  const out = []
  for (const { words, redirects } of parseShell(command)) {
    out.push(...redirects.filter((r) => !/^&?\d*$/.test(r) && r !== '/dev/null'))
    let w = words
    while (w.length && (/^\w+=/.test(w[0]) || ['sudo', 'env', 'command', 'xargs', 'nohup', 'time'].includes(w[0]))) w = w.slice(1)
    const [cmd, ...args] = w
    if (!cmd) continue
    const name = cmd.split('/').pop()
    const paths = args.filter((a) => !a.startsWith('-'))
    if (WRITERS[name] === 'args') out.push(...paths)
    else if (WRITERS[name] === 'last') out.push(...paths.slice(-1))
    else if ((name === 'sed' || name === 'perl' || name === 'ruby') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) out.push(...paths)
    else if (name === 'dd') out.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)))
    else if (name === 'git' && ['checkout', 'restore', 'apply', 'reset', 'mv', 'rm', 'clean', 'stash'].includes(paths[0]))
      out.push(...(paths.length > 1 ? paths.slice(1) : ['.']))
  }
  return out
}

/** Maps a routes.yaml `match` to its parity corpus name. */
export function corpusFor(root, match) {
  const dir = join(root, 'parity', 'corpus')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const corpus = parse(readFileSync(join(dir, f), 'utf8'))
    if (corpus?.match === match) return f.replace(/\.yaml$/, '')
  }
  return null
}

/**
 * Why a route may not be sent to the service yet, or null when it may.
 * The latest parity report must exist, have passed, and have run against
 * the service code and recording that are on disk now.
 */
export function flipBlocker(root, match) {
  const route = corpusFor(root, match)
  if (!route) return `${match} has no parity corpus in parity/corpus/, so nothing proves it matches legacy`
  const file = join(root, 'migration', 'parity', `${route}.json`)
  if (!existsSync(file)) return `${match} has no parity report: run npm run parity -- ${route}`
  const report = JSON.parse(readFileSync(file, 'utf8'))
  if (!report.passed)
    return `the last parity run for ${match} failed (${report.counts?.different ?? '?'} different cases): fix them and run npm run parity -- ${route}`
  if (report.serviceHash !== serviceHash(root))
    return `the parity report for ${match} is stale: service/src changed after it ran. Run npm run parity -- ${route}`
  const golden = join(root, 'parity', 'golden', `${route}.json`)
  if (!existsSync(golden) || report.goldenHash !== hashFiles(root, [golden]))
    return `the parity report for ${match} was made from a different recording. Run npm run parity -- ${route}`
  return null
}

const targets = (text) => {
  const doc = parse(text) ?? {}
  return new Map((doc.routes ?? []).map((r) => [r.match, r.to]))
}

/** Routes whose target becomes `service` between two versions of routes.yaml. */
export function flips(before, after) {
  const old = targets(before)
  return [...targets(after)].filter(([match, to]) => to === 'service' && old.get(match) !== 'service').map(([match]) => match)
}

/** The file content an Edit, MultiEdit or Write would leave behind. */
export function contentAfter(tool, input, current) {
  if (tool === 'Write') return input.content ?? ''
  const edits = tool === 'MultiEdit' ? (input.edits ?? []) : [input]
  let text = current
  for (const e of edits) {
    if (e.old_string === undefined) continue
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string)
  }
  return text
}

const JOURNAL_HEAD =
  '# Migration journal\n\nWritten by the Fig hooks: one row per tool call in a session with the plugin loaded.\n\n| time | tool | target | note |\n| --- | --- | --- | --- |\n'

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)

export function journal(root, tool, target, note = '') {
  const file = join(root, 'migration', 'journal.md')
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, JOURNAL_HEAD)
  const time = new Date().toISOString().slice(0, 19).replace('T', ' ')
  appendFileSync(file, `| ${time} | ${cell(tool)} | ${cell(target)} | ${cell(note)} |\n`)
}

/** What a tool call acted on, in a few words. */
export function describeTarget(root, tool, input = {}) {
  if (input.file_path) return inRepo(root, input.file_path) ?? input.file_path
  if (input.notebook_path) return inRepo(root, input.notebook_path) ?? input.notebook_path
  if (tool === 'Bash') return input.command ?? ''
  if (input.pattern) {
    const where = input.path ? (inRepo(root, input.path) ?? input.path) : ''
    return where ? `${input.pattern} in ${where}` : input.pattern
  }
  if (input.skill) return `/${input.skill}${input.args ? ` ${input.args}` : ''}`
  if (input.subagent_type) return `${input.subagent_type}: ${input.description ?? ''}`
  if (input.url) return input.url
  return Object.keys(input).slice(0, 3).join(', ')
}
