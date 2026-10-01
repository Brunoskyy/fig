#!/usr/bin/env node
// Records a person's approval of a route plan: who, when, and a hash of the
// plan text they approved. Editing the plan afterwards voids the approval
// until it is approved again. The guard hook stops the agent from running
// this or writing these lines itself.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { approvalProblem, planHash } from '../hooks/lib.mjs'

const route = process.argv[2]
if (!route) {
  console.error('usage: npm run approve -- <route>')
  process.exit(2)
}
const file = join(import.meta.dirname, '..', 'migration', 'routes', `${route}.md`)
if (!existsSync(file)) {
  console.error(`no plan at migration/routes/${route}.md`)
  process.exit(1)
}
const text = readFileSync(file, 'utf8')
const problem = approvalProblem(text)
if (!problem) {
  console.log(`migration/routes/${route}.md is already approved as it stands`)
  process.exit(0)
}
let who = process.env.USER ?? 'unknown'
try {
  who = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || who
} catch {
  // not a git checkout; fall back to the login name
}
// Earlier approval lines stay: they are the history of who signed what.
const lines = `Approved-by: ${who} on ${new Date().toISOString().slice(0, 10)}\nPlan-hash: sha256:${planHash(text)}`
writeFileSync(file, text.replace(/\s*$/, '\n\n') + lines + '\n')
if (/^Approved-by:/m.test(text)) console.log(`migration/routes/${route}.md was approved before, but ${problem}; approving this version`)
console.log(`${lines.replace('\n', ', ')} -> migration/routes/${route}.md`)
