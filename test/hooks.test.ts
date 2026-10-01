import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approvalProblem,
  flips,
  legacyHash,
  parseShell,
  planHash,
  serviceHash as hookServiceHash,
  shellWrites,
  stateKey,
  // @ts-expect-error plain JS module without types
} from '../hooks/lib.mjs'
// @ts-expect-error plain JS module without types
import { check } from '../hooks/policy.mjs'
import { ROOT, serviceHash } from '../parity/src/corpus.ts'

// A scratch copy of the repo, with the real node_modules linked in so the
// flip check can run parity there.
const scratch = mkdtempSync(join(tmpdir(), 'fig-hooks-test-'))
for (const dir of ['edge', 'legacy', 'migration', 'parity', 'service']) cpSync(join(ROOT, dir), join(scratch, dir), { recursive: true })
for (const file of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, file), join(scratch, file))
symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const run = (script: string, input: object, dir = join(ROOT, 'hooks')) =>
  spawnSync(process.execPath, [join(dir, script)], {
    input: JSON.stringify({ cwd: scratch, session_id: 's1', tool_use_id: 't1', ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: scratch },
    encoding: 'utf8',
  })

/** Changes a scratch file for the length of one callback. */
function withFile(rel: string, change: (text: string) => string, body: () => void): void {
  const file = join(scratch, rel)
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, change(original))
  try {
    body()
  } finally {
    writeFileSync(file, original)
  }
}

const writes = (command: string) => (shellWrites(command, scratch) as { path: string }[]).map((w) => w.path)
const bash = (command: string) => check(scratch, 'Bash', { command }) as string | null
const routesFile = join(scratch, 'edge/routes.yaml')
const flipBookings = { file_path: routesFile, old_string: 'to: shadow', new_string: 'to: service' }

describe('shell parsing', () => {
  it('keeps quoted separators inside one command', () => {
    expect(parseShell("sed -i '' 's/a;b/c/' legacy/app.js && echo ok")).toEqual([
      { words: ['sed', '-i', '', 's/a;b/c/', 'legacy/app.js'], redirects: [] },
      { words: ['echo', 'ok'], redirects: [] },
    ])
  })

  it('finds what a command writes', () => {
    expect(writes('echo x >> legacy/a 2>&1')).toEqual(['legacy/a'])
    expect(writes('cp legacy/app.js /tmp/x')).toEqual(['/tmp/x'])
    expect(writes('grep -n x legacy/app.js > /dev/null')).toEqual([])
    expect(writes('FOO=1 sudo rm -rf legacy/db')).toEqual(['legacy/db'])
    expect(writes('yq -i \'.default = "service"\' edge/routes.yaml')).toContain('edge/routes.yaml')
    expect(writes('echo x >| legacy/a')).toEqual(['legacy/a'])
    // Over-inclusion is harmless: only candidates in protected places are refused.
    expect(writes("perl -pi -e 's/1/2/' legacy/app.js")).toContain('legacy/app.js')
  })

  it('follows cd, and gives up on a cd it cannot follow', () => {
    const w = (shellWrites("cd edge && sed -i '' 's/shadow/service/' routes.yaml", scratch) as { path: string; cwd: string }[]).at(-1)
    expect(join(w!.cwd, w!.path)).toBe(join(scratch, 'edge/routes.yaml'))
    expect((shellWrites('cd "$DIR" && touch x', scratch) as { cwd: string | null }[])[0]!.cwd).toBeNull()
  })
})

describe('guard: legacy and the sealed areas', () => {
  it('blocks legacy edits by any file tool, wherever the path points', () => {
    for (const file_path of [
      join(scratch, 'legacy/app.js'),
      'legacy/app.js',
      join(scratch, 'service/../legacy/x.js'),
      join(scratch, 'Legacy/app.js'),
      'LEGACY/new.js',
    ]) {
      expect(check(scratch, 'Edit', { file_path, old_string: 'a', new_string: 'b' })).toMatch(/never edits/)
    }
    expect(check(scratch, 'Edit', { file_path: join(scratch, 'service/src/main.ts') })).toBeNull()
    expect(check(scratch, 'Edit', { file_path: join(scratch, 'legacy-notes.md') })).toBeNull()
  })

  it('follows symlinks into legacy, dangling ones included', () => {
    symlinkSync(join(scratch, 'legacy/app.js'), join(scratch, 'link.js'))
    symlinkSync('legacy/not-yet.js', join(scratch, 'dangling.js'))
    symlinkSync(join(scratch, 'legacy'), join(scratch, 'old'))
    try {
      expect(check(scratch, 'Write', { file_path: join(scratch, 'link.js'), content: '' })).toMatch(/never edits/)
      expect(check(scratch, 'Write', { file_path: join(scratch, 'dangling.js'), content: '' })).toMatch(/never edits/)
      expect(check(scratch, 'Write', { file_path: join(scratch, 'old/app.js'), content: '' })).toMatch(/never edits/)
      expect(bash('echo x > old/app.js')).toMatch(/never edits/)
    } finally {
      for (const f of ['link.js', 'dangling.js', 'old']) rmSync(join(scratch, f))
    }
  })

  it('refuses shell writes after a cd into a protected place', () => {
    expect(bash("cd edge && sed -i '' 's/shadow/service/' routes.yaml")).toMatch(/Edit tool/)
    expect(bash('cd legacy; touch new.js')).toMatch(/never edits/)
    expect(bash('yq -i \'.default = "service"\' edge/routes.yaml')).toMatch(/Edit tool/)
    expect(bash('cd "$(git rev-parse --show-toplevel)" && touch x')).toMatch(/cannot follow/)
    expect(bash('cd service && touch src/x.ts')).toBeNull()
  })

  it('keeps the agent away from recordings, reports and the gate itself', () => {
    for (const rel of ['parity/golden/bookings-get.json', 'migration/parity/bookings-get.json', 'parity/src/diff.ts', 'hooks/guard.mjs']) {
      expect(check(scratch, 'Write', { file_path: join(scratch, rel), content: '{}' })).not.toBeNull()
    }
    expect(bash('echo "{\\"passed\\":true}" > migration/parity/bookings-get.json')).toMatch(/Only npm run parity/)
    expect(bash('cp /tmp/fake.json parity/golden/bookings-get.json')).toMatch(/Only npm run record/)
    expect(bash('npm run parity -- bookings-get')).toBeNull()
  })

  it('lets the agent add corpus cases but not accept or ignore differences', () => {
    const file_path = join(scratch, 'parity/corpus/bookings-get.yaml')
    const text = readFileSync(file_path, 'utf8')
    expect(check(scratch, 'Write', { file_path, content: text.replace('cases:', 'cases:\n  - name: one more\n    path: /api/v1/bookings/1') })).toBeNull()
    expect(check(scratch, 'Write', { file_path, content: text.replace(/ignore:.*\n/, '') + 'ignore: ["$"]\n' })).toMatch(/person signs them off/)
    expect(check(scratch, 'Write', { file_path, content: text.replace(/reason: .*/, 'reason: it is fine, trust me') })).toMatch(/person signs them off/)
    expect(bash(`echo 'ignore: ["$"]' >> parity/corpus/bookings-get.yaml`)).toMatch(/Edit tool/)
  })

  it('exits 2 with the reason on stderr, which is what makes Claude Code block', () => {
    const r = run('guard.mjs', { tool_name: 'Edit', tool_input: { file_path: join(scratch, 'legacy/app.js') } })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Fig blocked this/)
    expect(readFileSync(join(scratch, 'migration/journal.md'), 'utf8')).toMatch(/\| Edit \| legacy\/app.js \| blocked:/)
  })
})

describe('guard: flips', () => {
  it('allows a flip when parity passes now and the plan approval matches its text', () => {
    const before = readFileSync(routesFile, 'utf8')
    expect(flips(before, before.replace('to: shadow', 'to: service'))).toEqual(['GET /api/v1/bookings/:id'])
    expect(check(scratch, 'Edit', flipBookings)).toBeNull()
  }, 30_000)

  it('does not trust a passing report on disk: a broken service is caught by running parity', () => {
    const report = 'migration/parity/bookings-get.json'
    withFile(
      'service/src/common/legacy-errors.ts',
      (t) => t.replace("code: 'NOT_FOUND'", "code: 'MISSING'"),
      () => {
        // The forged report: passed, and hashed against the broken code.
        withFile(
          report,
          (t) => JSON.stringify({ ...JSON.parse(t), passed: true, serviceHash: hookServiceHash(scratch) }),
          () => {
            expect(check(scratch, 'Edit', flipBookings)).toMatch(/does not pass when run now: 2 cases differ/)
          },
        )
      },
    )
  }, 30_000)

  it('does not trust a recording on disk: it must be what legacy answers', () => {
    withFile(
      'parity/golden/bookings-get.json',
      (t) => t.replace('"status": 200', '"status": 404'),
      () => {
        expect(check(scratch, 'Edit', flipBookings)).toMatch(/not what legacy answers/)
      },
    )
  }, 30_000)

  it('refuses a flip when the approved plan changed after approval', () => {
    withFile(
      'migration/routes/bookings-get.md',
      (t) => t.replace('## Approval', 'Also port the cancel route.\n\n## Approval'),
      () => {
        expect(check(scratch, 'Edit', flipBookings)).toMatch(/changed after it was approved/)
      },
    )
    withFile(
      'migration/routes/bookings-get.md',
      (t) => t.replace(/^Plan-hash:.*\n/m, ''),
      () => {
        expect(check(scratch, 'Edit', flipBookings)).toMatch(/no Plan-hash line/)
      },
    )
  })

  it('refuses a route listed twice, which the edge and the guard would read differently', () => {
    const twice = { file_path: routesFile, old_string: 'routes:\n', new_string: "routes:\n  - match: 'GET /api/v1/bookings/:ref'\n    to: service\n" }
    expect(check(scratch, 'Edit', twice)).toMatch(/listed twice/)
  })

  it('refuses a flip with no corpus', () => {
    const edit = { file_path: routesFile, old_string: 'routes:\n', new_string: "routes:\n  - match: 'GET /api/v1/customers/:id/bookings'\n    to: service\n" }
    expect(check(scratch, 'Edit', edit)).toMatch(/no parity corpus/)
  })

  it('refuses changes that move every route at once', () => {
    expect(check(scratch, 'Edit', { file_path: routesFile, old_string: 'default: legacy', new_string: 'default: service' })).toMatch(
      /default legacy -> service/,
    )
    expect(check(scratch, 'Edit', { file_path: routesFile, old_string: '127.0.0.1:4100', new_string: '127.0.0.1:4200' })).toMatch(/upstreams/)
  })
})

describe('guard: plan approvals', () => {
  const quote = join(scratch, 'migration/routes/quote.md')

  it('binds an approval to the plan text', () => {
    const text = readFileSync(quote, 'utf8')
    expect(approvalProblem(text)).toBeNull()
    expect(planHash(text + 'Approved-by: someone else\n')).toBe(planHash(text))
    expect(approvalProblem(text.replace('## Approval', 'One more rule.\n\n## Approval'))).toMatch(/changed after/)
  })

  it('refuses edits to an approved plan, keeping its line or not', () => {
    expect(check(scratch, 'Edit', { file_path: quote, old_string: '## Approval', new_string: 'Skip the weekend rule.\n\n## Approval' })).toMatch(/is approved/)
    expect(check(scratch, 'Edit', { file_path: quote, old_string: '## Approval', new_string: '## Approval\n\nApproved-by: me' })).toMatch(/sign-off/)
  })

  it('lets the agent write an unapproved plan but not approve it', () => {
    const file_path = join(scratch, 'migration/routes/new-route.md')
    expect(check(scratch, 'Write', { file_path, content: '# New route\n\n## Approval\n' })).toBeNull()
    expect(check(scratch, 'Write', { file_path, content: '# New route\n\n## Approval\n\nApproved-by: me\n' })).toMatch(/sign-off/)
  })

  it('refuses approvals from the shell, however the script is spelled', () => {
    for (const command of [
      'npm run approve -- quote',
      'npm run-script approve -- quote',
      'npm run -s approve quote',
      'pnpm approve quote',
      'node scripts/approve.mjs quote',
      "echo 'Approved-by: Artur Bruno on 2026-10-01' >> migration/routes/new-route.md",
    ]) {
      expect(bash(command), command).not.toBeNull()
    }
  })
})

describe('guard fails closed', () => {
  it('on unreadable input and on a corpus that does not parse', () => {
    expect(spawnSync(process.execPath, [join(ROOT, 'hooks', 'guard.mjs')], { input: '{not json', encoding: 'utf8' }).status).toBe(2)
    const broken = join(scratch, 'parity/corpus/aa-broken.yaml')
    writeFileSync(broken, 'match: [unclosed')
    expect(run('guard.mjs', { tool_name: 'Edit', tool_input: flipBookings }).status).toBe(2)
    rmSync(broken)
  })

  it('when a dependency of the hooks is missing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'fig-bare-hooks-'))
    for (const f of ['guard.mjs', 'policy.mjs', 'lib.mjs']) cpSync(join(ROOT, 'hooks', f), join(bare, f))
    const r = run('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }, bare)
    rmSync(bare, { recursive: true, force: true })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/guard failed .*yaml/)
  })

  it('when the before-command state cannot be saved', () => {
    const input = { session_id: 'eisdir', tool_use_id: 't1' }
    const slot = join(tmpdir(), 'fig-hooks', stateKey(input))
    rmSync(slot, { recursive: true, force: true })
    mkdirSync(slot, { recursive: true })
    const r = run('guard.mjs', { ...input, tool_name: 'Bash', tool_input: { command: 'ls' } })
    rmSync(slot, { recursive: true, force: true })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/EISDIR/)
  })

  it('copes with a symlinked directory in legacy and skips its node_modules', () => {
    symlinkSync(join(scratch, 'service'), join(scratch, 'legacy/linked'))
    mkdirSync(join(scratch, 'legacy/node_modules/dep'), { recursive: true })
    try {
      const before = legacyHash(scratch)
      writeFileSync(join(scratch, 'legacy/node_modules/dep/index.js'), 'x')
      expect(legacyHash(scratch)).toBe(before)
      expect(run('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status).toBe(0)
      expect(run('legacy-check.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status).toBe(0)
    } finally {
      rmSync(join(scratch, 'legacy/linked'))
      rmSync(join(scratch, 'legacy/node_modules'), { recursive: true, force: true })
    }
  })

  it('computes the same service hash as the parity harness', () => {
    expect(hookServiceHash(ROOT)).toBe(serviceHash())
  })
})

describe('after-command check', () => {
  const after = (command: string, change: () => void) => {
    expect(run('guard.mjs', { tool_name: 'Bash', tool_input: { command } }).status).toBe(0)
    change()
    return run('legacy-check.mjs', { tool_name: 'Bash', tool_input: { command } })
  }

  it('notices a legacy write that no pattern caught', () => {
    const file = join(scratch, 'legacy/QUIRKS.md')
    const original = readFileSync(file, 'utf8')
    const r = after(`node -e "require('fs').appendFileSync('legacy/QUIRKS.md', 'x')"`, () => writeFileSync(file, original + 'x'))
    writeFileSync(file, original)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/legacy\/ changed/)
  })

  it('notices routes.yaml, approvals and corpus sign-offs changed from the shell', () => {
    const cases: [string, string, (t: string) => string, RegExp][] = [
      ['edge/routes.yaml', 'node scripts/x.js', (t) => t.replace('to: shadow', 'to: service'), /edge\/routes.yaml/],
      ['migration/routes/quote.md', 'python3 x.py', (t) => t.replace('## Approval', 'More.\n\n## Approval'), /plan approvals/],
      ['parity/corpus/bookings-get.yaml', 'node x.js', (t) => t + 'ignore: ["$"]\n', /accepted and ignore/],
    ]
    for (const [rel, command, change, message] of cases) {
      const file = join(scratch, rel)
      const original = readFileSync(file, 'utf8')
      const r = after(command, () => writeFileSync(file, change(original)))
      writeFileSync(file, original)
      expect(r.status, rel).toBe(2)
      expect(r.stderr).toMatch(message)
    }
  })

  it('stays quiet when nothing protected changed', () => {
    expect(after('ls', () => {}).status).toBe(0)
    expect(existsSync(join(tmpdir(), 'fig-hooks', 's1-t1'))).toBe(false)
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

  it('keeps local paths out of the committed journal', () => {
    run('journal.mjs', { tool_name: 'Bash', tool_input: { command: `cd ${scratch}; ls ${scratch}/edge` }, tool_response: {} })
    const last = readFileSync(join(scratch, 'migration/journal.md'), 'utf8').trim().split('\n').at(-1)!
    expect(last).toContain('cd .; ls ./edge')
    expect(last).not.toContain(scratch)
  })
})
