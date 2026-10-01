import { tokenize } from './text.ts'

export interface Bm25 {
  search(query: string, limit: number): { index: number; score: number }[]
}

/** Okapi BM25 over the chunk texts, k1 = 1.2, b = 0.75. */
export function bm25(docs: readonly string[], k1 = 1.2, b = 0.75): Bm25 {
  const tokens = docs.map(tokenize)
  const avg = tokens.reduce((n, t) => n + t.length, 0) / Math.max(tokens.length, 1)
  const df = new Map<string, number>()
  const tf = tokens.map((ts) => {
    const m = new Map<string, number>()
    for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1)
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return m
  })
  const idf = (t: string) => {
    const n = df.get(t) ?? 0
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
  }
  return {
    search(query, limit) {
      const q = [...new Set(tokenize(query))]
      return tf
        .map((m, index) => {
          let score = 0
          const len = tokens[index]!.length
          for (const t of q) {
            const f = m.get(t)
            if (!f) continue
            score += (idf(t) * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg))
          }
          return { index, score }
        })
        .filter((r) => r.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, limit)
    },
  }
}
