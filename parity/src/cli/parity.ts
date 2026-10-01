import { routes } from '../corpus.ts'
import { replay, summarize } from '../harness.ts'
import { writeHtmlReport } from '../html.ts'

const wanted = process.argv.slice(2)
let failed = 0
for (const route of wanted.length ? wanted : routes()) {
  const report = await replay(route)
  console.log(summarize(report))
  if (!report.passed) failed += 1
}
console.log(`html: ${writeHtmlReport()}`)
process.exitCode = failed ? 1 : 0
