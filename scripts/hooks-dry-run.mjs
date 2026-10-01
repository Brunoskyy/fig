#!/usr/bin/env node
// Feeds the guard the same JSON Claude Code sends before a tool call and
// prints what it decided. Runs against a scratch copy of the repo, so the
// stale-report case can change service code without touching yours.
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'fig-dry-run-'))
for (const dir of ['edge', 'legacy', 'migration', 'parity', 'service']) cpSync(join(repo, dir), join(root, dir), { recursive: true })

const routes = (to) =>
  `upstreams: { legacy: "http://127.0.0.1:4100", service: "http://127.0.0.1:4200" }\nroutes:\n  - { match: "GET /api/v1/bookings/:id", to: ${to} }\n`

const cases = [
  ['edit legacy/app.js', 'Edit', { file_path: join(root, 'legacy/app.js'), old_string: 'var PAGE_SIZE = 10;', new_string: 'var PAGE_SIZE = 20;' }, 2],
  ['write a new file under legacy/', 'Write', { file_path: join(root, 'legacy/fix.js'), content: '' }, 2],
  ['sed -i on legacy from Bash', 'Bash', { command: "sed -i '' 's/1.05/1.0/' legacy/app.js" }, 2],
  [
    'sed -i with a ; inside the expression',
    'Bash',
    { command: "sed -i '' '22s/var PAGE_SIZE = 10;/var PAGE_SIZE = 20;/' legacy/app.js && sed -n 22p legacy/app.js" },
    2,
  ],
  ['redirect into legacy/', 'Bash', { command: 'echo x >> ./legacy/QUIRKS.md' }, 2],
  ['git checkout of a legacy file', 'Bash', { command: 'git checkout -- legacy/app.js' }, 2],
  ['copy out of legacy is fine', 'Bash', { command: 'cp legacy/app.js /tmp/app.js' }, 0],
  ['read legacy from Bash', 'Bash', { command: 'grep -n REVERSE legacy/app.js' }, 0],
  ['edit the service', 'Edit', { file_path: join(root, 'service/src/main.ts'), old_string: '4200', new_string: '4201' }, 0],
  [
    'agent writes its own plan approval',
    'Edit',
    { file_path: join(root, 'migration/routes/quote.md'), old_string: '## Approval', new_string: '## Approval\n\nApproved-by: me' },
    2,
  ],
  ['agent runs npm run approve', 'Bash', { command: 'npm run approve -- quote' }, 2],
  ['flip bookings with an accepted-only report', 'Write', { file_path: join(root, 'edge/routes.yaml'), content: routes('service') }, 0],
  [
    'flip a route with no corpus',
    'Write',
    { file_path: join(root, 'edge/routes.yaml'), content: routes('shadow').replace('bookings/:id', 'customers/:id/bookings').replace('shadow', 'service') },
    2,
  ],
  ['rewrite routes.yaml from Bash', 'Bash', { command: 'echo "routes: []" > edge/routes.yaml' }, 2],
  [
    'flip after the service changed (stale report)',
    'Write',
    { file_path: join(root, 'edge/routes.yaml'), content: routes('service') },
    2,
    () => appendFileSync(join(root, 'service/src/bookings/bookings.controller.ts'), '\n// changed\n'),
  ],
  ['send a route back to legacy', 'Write', { file_path: join(root, 'edge/routes.yaml'), content: routes('legacy') }, 0],
]

let wrong = 0
for (const [name, tool, input, expected, before] of cases) {
  before?.()
  const run = spawnSync(process.execPath, [join(repo, 'hooks', 'guard.mjs')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  })
  const ok = run.status === expected
  if (!ok) wrong += 1
  const verdict = run.status === 2 ? 'BLOCK' : run.status === 0 ? 'allow' : `exit ${run.status}`
  console.log(`${ok ? 'ok  ' : 'BAD '} ${verdict.padEnd(5)} ${name}${run.stderr ? `\n             ${run.stderr.trim()}` : ''}`)
}
rmSync(root, { recursive: true, force: true })
console.log(wrong ? `\n${wrong} unexpected decisions` : `\nall ${cases.length} decisions as expected`)
process.exitCode = wrong ? 1 : 0
