import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

import { ROOT, type Chunk } from './chunk.ts'
import type { Hit, LegacyIndex, Mode } from './search.ts'

const Gold = z.tuple([z.string(), z.number().int().positive(), z.number().int().positive()])
const Question = z.object({ id: z.string(), set: z.enum(['plain', 'code']), q: z.string().min(5), gold: z.array(Gold).min(1) })
const File = z.object({ questions: z.array(Question).min(1) })

export type EvalQuestion = z.infer<typeof Question>

export const QUESTIONS = join(ROOT, 'index', 'eval', 'questions.yaml')

export function loadQuestions(file = QUESTIONS): EvalQuestion[] {
  const { questions } = File.parse(parse(readFileSync(file, 'utf8')))
  const ids = new Set<string>()
  for (const q of questions) {
    if (ids.has(q.id)) throw new Error(`duplicate question id ${q.id}`)
    ids.add(q.id)
  }
  return questions
}

/** A chunk answers a gold range when it is in the same file and the lines overlap. */
export const covers = (c: Pick<Chunk, 'file' | 'start' | 'end'>, [file, start, end]: z.infer<typeof Gold>) => c.file === file && c.start <= end && c.end >= start

export interface QuestionResult {
  id: string
  set: EvalQuestion['set']
  /** 1-based rank of the first relevant chunk, or null if none in the top k. */
  firstHit: number | null
  recall: number
  top: string[]
}

export interface Metrics {
  n: number
  recallAt5: number
  mrr: number
  hitAt1: number
}

export interface ModeResult {
  mode: Mode
  all: Metrics
  plain: Metrics
  code: Metrics
  questions: QuestionResult[]
}

export function score(question: EvalQuestion, hits: Hit[]): QuestionResult {
  const firstHit = hits.find((h) => question.gold.some((g) => covers(h.chunk, g)))?.rank ?? null
  const found = question.gold.filter((g) => hits.some((h) => covers(h.chunk, g))).length
  return { id: question.id, set: question.set, firstHit, recall: found / question.gold.length, top: hits.map((h) => h.chunk.id) }
}

const round = (x: number) => Math.round(x * 1000) / 1000

export async function evaluate(index: LegacyIndex, questions: EvalQuestion[], mode: Mode, k = 5): Promise<ModeResult> {
  const results: QuestionResult[] = []
  for (const q of questions) results.push(score(q, await index.search(q.q, mode, k)))
  return {
    mode,
    all: metrics(results),
    plain: metrics(results.filter((r) => r.set === 'plain')),
    code: metrics(results.filter((r) => r.set === 'code')),
    questions: results,
  }
}

export function metrics(results: QuestionResult[]): Metrics {
  const n = results.length || 1
  return {
    n: results.length,
    recallAt5: round(results.reduce((s, r) => s + r.recall, 0) / n),
    mrr: round(results.reduce((s, r) => s + (r.firstHit ? 1 / r.firstHit : 0), 0) / n),
    hitAt1: round(results.filter((r) => r.firstHit === 1).length / n),
  }
}
