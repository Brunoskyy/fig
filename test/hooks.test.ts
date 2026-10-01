import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module without types
import { check } from '../hooks/guard.mjs'
// @ts-expect-error plain JS module without types
import { flips, parseShell, serviceHash as hookServiceHash, shellWrites } from '../hooks/lib.mjs'
import { ROOT, serviceHash } from '../parity/src/corpus.ts'

const scratch = mkdtempSync(join(tmpdir(), 'fig-hooks-test-'))
for (const dir of ['edge', 'legacy', 'migration', 'parity', 'service']) cpSync(join(ROOT, dir), join(scratch, dir), { recursive: true })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const run = (script: string, input: object) =>
  spawnSync(process.execPath, [join(ROOT, 'hooks', script)], {
    input: JSON.stringify({ cwd: scratch, session_id: 's1', tool_use_id: 't1', ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: scratch },
    encoding: 'utf8',
  })

describe('shell parsing', () => {
  it('keeps quoted separators inside one command', () => {
    expect(parseShell("sed -i '' 's/a;b/c/' legacy/app.js && echo ok")).toEqual([
      { words: ['sed', '-i', '', 's/a;b/c/', 'legacy/app.js'], redirects: [] },
      { words: ['echo', 'ok'], redirects: [] },
    ])
  })

  it('finds what a command writes', () => {
    expect(shellWrites('echo x >> legacy/a 2>&1')).toEqual(['legacy/a'])
    expect(shellWrites('cp legacy/app.js /tmp/x')).toEqual(['/tmp/x'])
    expect(shellWrites('grep -n x legacy/app.js > /dev/null')).toEqual([])
    expect(shellWrites('FOO=1 sudo rm -rf legacy/db')).toEqual(['legacy/db'])
    // Over-inclusion is harmless: only candidates under legacy/ are refused.
    expect(shellWrites("perl -pi -e 's/1/2/' legacy/app.js")).toContain('legacy/app.js')
  })
})

describe('guard', () => {
  it('blocks legacy edits by any file tool, wherever the path points', () => {
    for (const file_path of [join(scratch, 'legacy/app.js'), 'legacy/app.js', join(scratch, 'service/../legacy/x.js')]) {
      expect(check(scratch, 'Edit', { file_path, old_string: 'a', new_string: 'b' })).toMatch(/never edits/)
    }
    expect(check(scratch, 'Edit', { file_path: join(scratch, 'service/src/main.ts') })).toBeNull()
    expect(check(scratch, 'Edit', { file_path: join(scratch, 'legacy-notes.md') })).toBeNull()
  })

  it('exits 2 with the reason on stderr, which is what makes Claude Code block', () => {
    const r = run('guard.mjs', { tool_name: 'Edit', tool_input: { file_path: join(scratch, 'legacy/app.js') } })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Fig blocked this/)
    expect(readFileSync(join(scratch, 'migration/journal.md'), 'utf8')).toMatch(/\| Edit \| legacy\/app.js \| blocked:/)
  })

  it('reads a flip out of an edit and checks the report', () => {
    const before = readFileSync(join(scratch, 'edge/routes.yaml'), 'utf8')
    expect(flips(before, before.replace('to: shadow', 'to: service'))).toEqual(['GET /api/v1/bookings/:id'])
    const edit = { file_path: join(scratch, 'edge/routes.yaml'), old_string: 'to: shadow', new_string: 'to: service' }
    expect(check(scratch, 'Edit', edit)).toBeNull()
    writeFileSync(join(scratch, 'service/src/extra.ts'), 'export {}\n')
    expect(check(scratch, 'Edit', edit)).toMatch(/stale/)
    rmSync(join(scratch, 'service/src/extra.ts'))
  })

  it('refuses a failing report', () => {
    const file = join(scratch, 'migration/parity/bookings-get.json')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), passed: false }))
    const edit = { file_path: join(scratch, 'edge/routes.yaml'), old_string: 'to: shadow', new_string: 'to: service' }
    expect(check(scratch, 'Edit', edit)).toMatch(/failed/)
    writeFileSync(file, original)
  })

  it('computes the same service hash as the parity harness', () => {
    expect(hookServiceHash(ROOT)).toBe(serviceHash())
  })
})

describe('after-command check', () => {
  it('notices a legacy write that no pattern caught', () => {
    const command = `node -e "require('fs').appendFileSync('legacy/QUIRKS.md', 'x')"`
    expect(run('guard.mjs', { tool_name: 'Bash', tool_input: { command } }).status).toBe(0)
    writeFileSync(join(scratch, 'legacy/QUIRKS.md'), readFileSync(join(scratch, 'legacy/QUIRKS.md'), 'utf8') + 'x')
    const after = run('legacy-check.mjs', { tool_name: 'Bash', tool_input: { command } })
    expect(after.status).toBe(2)
    expect(after.stderr).toMatch(/legacy\/ changed/)
  })

  it('stays quiet when legacy is untouched', () => {
    expect(run('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status).toBe(0)
    expect(run('legacy-check.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status).toBe(0)
  })
})

describe('journal', () => {
  it('logs one row per tool call and never fails it', () => {
    const r = run('journal.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'npm run parity -- quote' },
      tool_response: { stdout: 'PASS POST /api/v1/quote  same 33\n' },
    })
    expect(r.status).toBe(0)
    expect(readFileSync(join(scratch, 'migration/journal.md'), 'utf8')).toMatch(/\| Bash \| npm run parity -- quote \| PASS POST \/api\/v1\/quote \|/)
    expect(spawnSync(process.execPath, [join(ROOT, 'hooks', 'journal.mjs')], { input: 'not json', encoding: 'utf8' }).status).toBe(0)
  })
})
