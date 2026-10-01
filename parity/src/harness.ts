import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { GOLDEN_DIR, REPORT_DIR, ROOT, hashFiles, loadCorpus, serviceHash, type RouteCorpus } from './corpus.ts'
import { compareResponses, type Captured, type Difference } from './diff.ts'
import { PARITY_NOW, requestFor, send, start } from './http.ts'

export interface GoldenCase {
  name: string
  request: ReturnType<typeof requestFor>
  response: Captured
}

export interface Golden {
  route: string
  match: string
  recordedAt: string
  clock: string
  corpusHash: string
  cases: GoldenCase[]
}

export type CaseOutcome = 'same' | 'accepted' | 'different'

export interface CaseResult {
  name: string
  request: ReturnType<typeof requestFor>
  outcome: CaseOutcome
  reason?: string
  differences: Difference[]
  legacy: Captured
  service: Captured
}

export interface ParityReport {
  route: string
  match: string
  passed: boolean
  ranAt: string
  /** Hash of service/src when this ran. The flip guard refuses a report whose hash no longer matches. */
  serviceHash: string
  goldenHash: string
  ignored: string[]
  counts: Record<CaseOutcome, number>
  cases: CaseResult[]
}

export const goldenFile = (route: string) => join(GOLDEN_DIR, `${route}.json`)
export const reportFile = (route: string) => join(REPORT_DIR, `${route}.json`)

/** Characterization: run the corpus against the legacy app and keep what it said, verbatim. */
export async function record(route: string, options: { write?: boolean } = {}): Promise<Golden> {
  const corpus = loadCorpus(route)
  const legacy = await start('legacy', corpus)
  const cases: GoldenCase[] = []
  try {
    for (const c of corpus.cases) {
      const request = requestFor(corpus, c)
      cases.push({ name: c.name, request, response: await send(legacy.url, request) })
    }
  } finally {
    await legacy.stop()
  }
  const golden: Golden = {
    route,
    match: corpus.match,
    recordedAt: new Date().toISOString(),
    clock: PARITY_NOW,
    corpusHash: hashFiles([join(ROOT, corpus.file)]),
    cases,
  }
  if (options.write !== false) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(goldenFile(route), JSON.stringify(golden, null, 2) + '\n')
  }
  return golden
}

export function loadGolden(route: string, corpus: RouteCorpus): Golden {
  const file = goldenFile(route)
  if (!existsSync(file)) throw new Error(`no recording for ${route}: run npm run record -- ${route}`)
  const golden = JSON.parse(readFileSync(file, 'utf8')) as Golden
  const current = hashFiles([join(ROOT, corpus.file)])
  if (golden.corpusHash !== current) throw new Error(`${route}: the corpus changed since it was recorded, run npm run record -- ${route}`)
  return golden
}

/** Replays the recording against the new service and compares every case. */
export async function replay(route: string, options: { write?: boolean } = {}): Promise<ParityReport> {
  const corpus = loadCorpus(route)
  const golden = loadGolden(route, corpus)
  const accepted = new Map(corpus.accepted.map((a) => [a.case, a.reason]))
  const service = await start('service', corpus)
  const cases: CaseResult[] = []
  try {
    for (const g of golden.cases) {
      const got = await send(service.url, g.request)
      const differences = compareResponses(g.response, got, { ignore: corpus.ignore })
      const reason = accepted.get(g.name)
      const outcome: CaseOutcome = differences.length === 0 ? 'same' : reason ? 'accepted' : 'different'
      cases.push({ name: g.name, request: g.request, outcome, ...(reason && differences.length ? { reason } : {}), differences, legacy: g.response, service: got })
    }
  } finally {
    await service.stop()
  }
  const counts = { same: 0, accepted: 0, different: 0 }
  for (const c of cases) counts[c.outcome] += 1
  const report: ParityReport = {
    route,
    match: corpus.match,
    passed: counts.different === 0,
    ranAt: new Date().toISOString(),
    serviceHash: serviceHash(),
    goldenHash: hashFiles([goldenFile(route)]),
    ignored: corpus.ignore,
    counts,
    cases,
  }
  if (options.write !== false) {
    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(reportFile(route), JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'undefined')

export function summarize(report: ParityReport): string {
  const lines = [`${report.passed ? 'PASS' : 'FAIL'} ${report.match}  same ${report.counts.same}, accepted ${report.counts.accepted}, different ${report.counts.different}`]
  if (report.ignored.length) lines.push(`  ignoring: ${report.ignored.join(', ')}`)
  for (const c of report.cases) {
    if (c.outcome === 'same') continue
    lines.push(`  ${c.outcome === 'accepted' ? '~' : 'x'} ${c.name}${c.reason ? `  (accepted: ${c.reason})` : ''}`)
    for (const d of c.differences.slice(0, 6)) lines.push(`      ${d.path}: legacy ${show(d.legacy)}  service ${show(d.service)}`)
    if (c.differences.length > 6) lines.push(`      ... ${c.differences.length - 6} more`)
  }
  lines.push(`  report: ${relative(ROOT, reportFile(report.route))}`)
  return lines.join('\n')
}
