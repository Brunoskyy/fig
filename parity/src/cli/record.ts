import { relative } from 'node:path'

import { ROOT, routes } from '../corpus.ts'
import { goldenFile, record } from '../harness.ts'

const wanted = process.argv.slice(2)
for (const route of wanted.length ? wanted : routes()) {
  const golden = await record(route)
  console.log(`recorded ${golden.cases.length} cases for ${golden.match} -> ${relative(ROOT, goldenFile(route))}`)
}
