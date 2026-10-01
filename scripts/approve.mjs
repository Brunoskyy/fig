#!/usr/bin/env node
// Records a person's approval of a route plan. The guard hook stops the
// agent from running this or writing the line itself.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
if (/^Approved-by:/m.test(text)) {
  console.log(`migration/routes/${route}.md is already approved`)
  process.exit(0)
}
let who = process.env.USER ?? 'unknown'
try {
  who = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || who
} catch {
  // not a git checkout; fall back to the login name
}
const line = `Approved-by: ${who} on ${new Date().toISOString().slice(0, 10)}`
writeFileSync(file, text.replace(/\s*$/, '\n\n') + line + '\n')
console.log(`${line} -> migration/routes/${route}.md`)
