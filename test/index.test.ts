import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bm25 } from '../index/src/bm25.ts'
import { chunkJs, chunkLegacy, ROOT } from '../index/src/chunk.ts'
import { MODEL, MODEL_DIR } from '../index/src/embed.ts'
import { covers, loadQuestions, score } from '../index/src/eval.ts'
import { fuse, LegacyIndex } from '../index/src/search.ts'
import { tokenize } from '../index/src/text.ts'

const chunks = chunkLegacy()

describe('chunker', () => {
  it('cuts the legacy app at route handlers and functions', () => {
    const quote = chunks.find((c) => c.name === 'POST /api/v1/quote')!
    expect(quote.kind).toBe('route')
    const lines = readFileSync(join(ROOT, 'legacy/app.js'), 'utf8').split('\n')
    expect(lines[quote.start - 1]).toContain("app.post('/api/v1/quote'")
    expect(lines[quote.end - 1]).toMatch(/^\s*\}\);/)
    expect(chunks.find((c) => c.name === 'price')?.kind).toBe('function')
    // createApp is too big to be one chunk: its handlers are chunks, and so
    // is the setup code before the first one.
    expect(chunks.find((c) => c.name === 'createApp')).toBeUndefined()
    expect(chunks.find((c) => c.name === 'createApp (setup)')?.text).toContain("app.disable('x-powered-by')")
  })

  it('keeps the comment block above a chunk', () => {
    const cancel = chunks.find((c) => c.name === 'POST /api/v1/bookings/:id/cancel')!
    expect(cancel.text.split('\n')[0]).toMatch(/^\s*\/\/ Cancellation fees/)
  })

  it('does not nest chunks', () => {
    for (const a of chunks) for (const b of chunks) if (a !== b && a.file === b.file) expect(a.start > b.end || a.end < b.start).toBe(true)
  })

  it('names error handlers and groups top-level constants', () => {
    const src = "var A = 1;\nvar B = 2;\nfunction f() {}\napp.use(function (err, req, res, next) {});\napp.get('/x', function () {});\n"
    expect(chunkJs('x.js', src).map((c) => [c.kind, c.name, c.start, c.end])).toEqual([
      ['constants', 'A, B', 1, 2],
      ['function', 'f', 3, 3],
      ['route', 'error handler', 4, 4],
      ['route', 'GET /x', 5, 5],
    ])
  })

  it('cuts SQL per statement', () => {
    expect(chunks.filter((c) => c.kind === 'sql').map((c) => c.name)).toContain('create table quotes')
  })
})

describe('keyword search', () => {
  it('splits identifiers and stems', () => {
    expect(tokenize('REVERSE_LANE_FACTOR baseCents bookings')).toEqual(['reverse', 'lane', 'factor', 'base', 'cent', 'booking'])
  })

  it('ranks the document with the rare word first', () => {
    const index = bm25(['the weekend fee', 'the fee', 'fee fee fee'])
    expect(index.search('weekend fee', 3)[0]!.index).toBe(0)
  })
})

describe('fusion', () => {
  it('rewards items both lists agree on', () => {
    const fused = fuse([
      [{ index: 1 }, { index: 2 }, { index: 3 }],
      [{ index: 2 }, { index: 9 }, { index: 1 }],
    ])
    expect(fused[0]!.index).toBe(2)
    expect(fused.map((f) => f.index)).toContain(9)
  })
})

describe('eval set', () => {
  const questions = loadQuestions()

  it('has about thirty plain questions plus the code set', () => {
    expect(questions.filter((q) => q.set === 'plain').length).toBeGreaterThanOrEqual(30)
  })

  it('points every gold range at real, non-empty lines covered by some chunk', () => {
    for (const q of questions) {
      for (const g of q.gold) {
        const lines = readFileSync(join(ROOT, g[0]), 'utf8').split('\n')
        expect(g[1], q.id).toBeLessThanOrEqual(g[2])
        expect(g[2], q.id).toBeLessThanOrEqual(lines.length)
        expect(
          lines
            .slice(g[1] - 1, g[2])
            .join('')
            .trim(),
          q.id,
        ).not.toBe('')
        expect(
          chunks.some((c) => covers(c, g)),
          q.id,
        ).toBe(true)
      }
    }
  })

  // Leakage: a plain question that names the function or route it is about
  // measures string matching, not retrieval.
  it('plain questions do not use names from the code they point at', () => {
    for (const q of questions.filter((x) => x.set === 'plain')) {
      const gold = chunks.filter((c) => q.gold.some((g) => covers(c, g)))
      const names = gold.flatMap((c) => [
        ...c.name.split(/[\s,]+/).filter((n) => /[A-Z_]|^\//.test(n) || n.length > 4),
        ...(c.text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []),
        ...(c.text.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []),
      ])
      for (const n of names) expect(q.q.includes(n), `${q.id} uses "${n}"`).toBe(false)
      for (const c of gold) {
        const words = c.text.toLowerCase().match(/[a-z]+/g) ?? []
        const question =
          q.q
            .toLowerCase()
            .match(/[a-z]+/g)
            ?.join(' ') ?? ''
        for (let i = 0; i + 4 <= words.length; i += 1) {
          const run = words.slice(i, i + 4).join(' ')
          expect(question.includes(run), `${q.id} copies "${run}"`).toBe(false)
        }
      }
    }
  })

  it('scores recall over ranges and the rank of the first hit', () => {
    const q = {
      id: 'x',
      set: 'plain' as const,
      q: 'question',
      gold: [['a.js', 10, 12] as [string, number, number], ['a.js', 40, 41] as [string, number, number]],
    }
    const hit = (start: number, end: number, rank: number) => ({
      chunk: { id: `a.js:${start}`, file: 'a.js', start, end, kind: 'function' as const, name: 'f', text: '' },
      score: 1,
      rank,
    })
    expect(score(q, [hit(1, 5, 1), hit(11, 20, 2)])).toMatchObject({ firstHit: 2, recall: 0.5 })
  })
})

const hasModel = existsSync(join(MODEL_DIR, MODEL, 'onnx', 'model_quantized.onnx'))

describe.skipIf(!hasModel)('hybrid search with the local model', () => {
  it('finds the weekend rule', async () => {
    const index = await LegacyIndex.open()
    const hits = await index.search('where is the weekend surcharge rule?', 'hybrid', 5)
    expect(hits.some((h) => h.chunk.name === 'isWeekend' || h.chunk.name === 'price')).toBe(true)
  })
})
