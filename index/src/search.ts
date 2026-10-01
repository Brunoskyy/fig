import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHash } from 'node:crypto'

import { bm25, type Bm25 } from './bm25.ts'
import { chunkLegacy, ROOT, SOURCES, type Chunk } from './chunk.ts'
import { cosine, embedPassages, embedQuery, MODEL } from './embed.ts'

export type Mode = 'keyword' | 'vector' | 'hybrid'
export const MODES: Mode[] = ['keyword', 'vector', 'hybrid']

const CACHE = join(ROOT, 'index', '.cache', 'index.json')
/** The usual RRF constant; it keeps one list's first place from drowning the other list. */
export const RRF_K = 60

interface Stored {
  model: string
  sourceHash: string
  chunks: Chunk[]
  vectors: number[][]
}

export interface Hit {
  chunk: Chunk
  score: number
  rank: number
}

/** The text a chunk is searched by: where it is and what it is called, then the code. */
const searchable = (c: Chunk) => `${c.file} ${c.kind} ${c.name}\n${c.text}`

function sourceHash(): string {
  const h = createHash('sha256')
  for (const f of SOURCES) h.update(f).update(readFileSync(join(ROOT, f)))
  return h.digest('hex').slice(0, 16)
}

export class LegacyIndex {
  private readonly keyword: Bm25

  private constructor(
    readonly chunks: Chunk[],
    private readonly vectors: number[][],
  ) {
    this.keyword = bm25(chunks.map(searchable))
  }

  /** Loads the cached index, rebuilding it when the legacy code changed. */
  static async open(options: { rebuild?: boolean } = {}): Promise<LegacyIndex> {
    const hash = sourceHash()
    if (!options.rebuild && existsSync(CACHE)) {
      const stored = JSON.parse(readFileSync(CACHE, 'utf8')) as Stored
      if (stored.sourceHash === hash && stored.model === MODEL) return new LegacyIndex(stored.chunks, stored.vectors)
    }
    const chunks = chunkLegacy()
    const vectors = await embedPassages(chunks.map(searchable))
    mkdirSync(join(ROOT, 'index', '.cache'), { recursive: true })
    writeFileSync(CACHE, JSON.stringify({ model: MODEL, sourceHash: hash, chunks, vectors } satisfies Stored))
    return new LegacyIndex(chunks, vectors)
  }

  async search(query: string, mode: Mode = 'hybrid', limit = 5): Promise<Hit[]> {
    const pool = Math.max(limit, 20)
    const keyword = () => this.keyword.search(query, pool)
    const vector = async () => {
      const q = await embedQuery(query)
      return this.vectors
        .map((v, index) => ({ index, score: cosine(q, v) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, pool)
    }
    let ranked: { index: number; score: number }[]
    if (mode === 'keyword') ranked = keyword()
    else if (mode === 'vector') ranked = await vector()
    else ranked = fuse([keyword(), await vector()])
    return ranked.slice(0, limit).map((r, i) => ({ chunk: this.chunks[r.index]!, score: r.score, rank: i + 1 }))
  }
}

/** Reciprocal rank fusion: each list adds 1 / (k + rank) for every item it ranks. */
export function fuse(lists: { index: number }[][], k = RRF_K): { index: number; score: number }[] {
  const scores = new Map<number, number>()
  for (const list of lists) list.forEach((r, i) => scores.set(r.index, (scores.get(r.index) ?? 0) + 1 / (k + i + 1)))
  return [...scores].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index)
}
