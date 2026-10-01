import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

export const ROOT = join(import.meta.dirname, '..', '..')
export const CORPUS_DIR = join(ROOT, 'parity', 'corpus')
export const GOLDEN_DIR = join(ROOT, 'parity', 'golden')
export const REPORT_DIR = join(ROOT, 'migration', 'parity')
/** The service code a report vouches for. A report is stale once any of it changes. */
export const SERVICE_DIR = join(ROOT, 'service', 'src')

const Case = z
  .object({
    name: z.string().min(1),
    path: z.string().startsWith('/').optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    /** A body sent byte for byte, for malformed input. */
    raw: z.string().optional(),
  })
  .refine((c) => !(c.body !== undefined && c.raw !== undefined), 'a case has body or raw, not both')

const Corpus = z.object({
  match: z.string().regex(/^(GET|HEAD|POST|PUT|PATCH|DELETE) \/\S*$/),
  /** SQL run on both fresh databases before the first case. */
  setup: z.string().optional(),
  /** JSON paths left out of the comparison. Every one is printed in the report. */
  ignore: z.array(z.string()).default([]),
  cases: z.array(Case).min(1),
  /** Cases whose differences are intentional. Reported, never hidden, and they do not fail the run. */
  accepted: z.array(z.object({ case: z.string(), reason: z.string().min(10) })).default([]),
})

export type CorpusCase = z.infer<typeof Case>
export type RouteCorpus = z.infer<typeof Corpus> & { route: string; method: string; file: string }

export function routes(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort()
}

export function loadCorpus(route: string): RouteCorpus {
  const file = join(CORPUS_DIR, `${route}.yaml`)
  const corpus = Corpus.parse(parse(readFileSync(file, 'utf8')))
  const names = new Set<string>()
  for (const c of corpus.cases) {
    if (names.has(c.name)) throw new Error(`${route}: duplicate case "${c.name}"`)
    names.add(c.name)
  }
  for (const a of corpus.accepted) {
    if (!names.has(a.case)) throw new Error(`${route}: accepted case "${a.case}" is not in the corpus`)
  }
  const method = corpus.match.split(' ')[0]!
  return { ...corpus, route, method, file: relative(ROOT, file) }
}

/** Finds the corpus for a routes.yaml `match`, so the flip guard can go from a route to its report. */
export function routeForMatch(match: string): string | null {
  for (const r of routes()) if (loadCorpus(r).match === match) return r
  return null
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort()
}

export function hashFiles(files: string[]): string {
  const h = createHash('sha256')
  for (const f of files) {
    h.update(relative(ROOT, f)).update('\0').update(readFileSync(f)).update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

export const serviceHash = () => hashFiles(walk(SERVICE_DIR))
