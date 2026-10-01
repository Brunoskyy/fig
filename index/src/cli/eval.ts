import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ROOT } from '../chunk.ts'
import { MODEL } from '../embed.ts'
import { evaluate, loadQuestions, type ModeResult } from '../eval.ts'
import { LegacyIndex, MODES, RRF_K } from '../search.ts'

const questions = loadQuestions()
const index = await LegacyIndex.open()
const results: ModeResult[] = []
for (const mode of MODES) results.push(await evaluate(index, questions, mode))

const date = new Date().toISOString().slice(0, 10)
const dir = join(ROOT, 'index', 'eval', 'runs')
mkdirSync(dir, { recursive: true })
const run = { date, model: MODEL, rrfK: RRF_K, chunks: index.chunks.length, questions: questions.length, results }
const file = join(dir, `${date}.json`)
writeFileSync(file, JSON.stringify(run, null, 2) + '\n')

const f = (x: number) => x.toFixed(3)
const table = [
  '| mode | set | questions | recall@5 | MRR | hit@1 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...(['plain', 'code', 'all'] as const).flatMap((set) =>
    results.map((r) => `| ${r.mode} | ${set} | ${r[set].n} | ${f(r[set].recallAt5)} | ${f(r[set].mrr)} | ${f(r[set].hitAt1)} |`),
  ),
].join('\n')
const misses = results
  .flatMap((r) => r.questions.filter((q) => q.firstHit === null).map((q) => `- ${r.mode}: \`${q.id}\` (${q.set})`))
  .join('\n')
writeFileSync(
  join(ROOT, 'index', 'eval', 'RESULTS.md'),
  `# Index eval, ${date}\n\n${questions.length} questions (plain: business words only; code: names copied from the code) over ${index.chunks.length} chunks of the legacy code. Model ${MODEL}, RRF k = ${RRF_K}. Raw run: [runs/${date}.json](runs/${date}.json).\n\n${table}\n\nMissed in the top 5:\n\n${misses || '- none'}\n`,
)
console.log(table)
console.log(`run: ${relative(ROOT, file)}`)
