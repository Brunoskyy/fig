import { loadCorpus } from './corpus.ts'
import { loadGolden, record, replay } from './harness.ts'

export interface Verdict {
  route: string
  passed: boolean
  why?: string
  counts?: Record<string, number>
}

/**
 * What the flip guard trusts instead of the files on disk: the recording is
 * made again from legacy and must equal the committed one, then the service
 * is replayed against it. Nothing is written, so a report or a recording
 * edited by hand cannot vouch for a route.
 */
export async function verify(route: string): Promise<Verdict> {
  const corpus = loadCorpus(route)
  const golden = loadGolden(route, corpus)
  const fresh = await record(route, { write: false })
  if (JSON.stringify(fresh.cases) !== JSON.stringify(golden.cases)) {
    const changed = fresh.cases.filter((c, i) => JSON.stringify(c) !== JSON.stringify(golden.cases[i])).map((c) => c.name)
    return { route, passed: false, why: `parity/golden/${route}.json is not what legacy answers (${changed.slice(0, 3).join(', ') || 'case list'} differ)` }
  }
  const report = await replay(route, { write: false })
  if (!report.passed) return { route, passed: false, why: `${report.counts.different} cases differ from legacy`, counts: report.counts }
  return { route, passed: true, counts: report.counts }
}
