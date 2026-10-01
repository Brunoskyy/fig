#!/usr/bin/env node
// PreToolUse guard. Exit code 2 blocks the tool call and shows stderr to
// the agent, which is how Claude Code hooks refuse an action.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tmpdir } from 'node:os'

import { contentAfter, flipBlocker, flips, inRepo, journal, legacyHash, projectRoot, readInput, shellWrites } from './lib.mjs'

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const APPROVAL = /^Approved-by:/m

export function check(root, tool, input) {
  if (FILE_TOOLS.has(tool)) {
    const rel = inRepo(root, input.file_path ?? input.notebook_path)
    if (!rel) return null
    if (rel === 'legacy' || rel.startsWith('legacy/')) {
      return `${rel} is part of the legacy system, which Fig never edits. Port the behaviour into service/ instead; if legacy really has to change, a person does it outside the migration.`
    }
    if (rel.startsWith('migration/routes/') && rel.endsWith('.md')) {
      const file = join(root, rel)
      const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const after = contentAfter(tool, input, before)
      if (APPROVAL.test(after) && after.match(new RegExp(APPROVAL.source, 'gm'))?.join() !== before.match(new RegExp(APPROVAL.source, 'gm'))?.join()) {
        return `the Approved-by line in ${rel} is the person's sign-off and cannot be written by the agent. Ask them to review the plan and run: npm run approve -- ${rel.slice('migration/routes/'.length, -3)}`
      }
    }
    if (rel === 'edge/routes.yaml') {
      const file = join(root, rel)
      const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
      let flipped
      try {
        flipped = flips(before, contentAfter(tool, input, before))
      } catch (e) {
        return `edge/routes.yaml would no longer parse: ${e.message}`
      }
      for (const match of flipped) {
        const why = flipBlocker(root, match)
        if (why) return `cannot send ${match} to the service: ${why}.`
      }
    }
    return null
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    for (const target of shellWrites(cmd)) {
      // A bare `.` (git checkout .) or a cd into legacy/ first: judge by where the shell is.
      const rel = inRepo(root, target)
      if (rel === '' || rel === '.' || rel === 'legacy' || rel?.startsWith('legacy/')) {
        if (rel === '' || rel === '.') {
          if (/\bgit\b/.test(cmd)) return 'that git command would rewrite the whole tree, legacy/ included. Name the paths outside legacy/ instead.'
          continue
        }
        return `that command writes ${rel}, which is part of the legacy system. Fig never edits it.`
      }
      if (rel === 'edge/routes.yaml') return 'change edge/routes.yaml with the Edit tool, so the parity check can see the flip.'
    }
    if (/\bcd\s+["']?(\.\/)?legacy\b/.test(cmd) && shellWrites(cmd).length) {
      return 'that command changes into legacy/ and then writes. Fig never edits legacy/.'
    }
    if (/\bnpm\s+run\s+approve\b|scripts\/approve\.mjs/.test(cmd)) {
      return 'approving a plan is for the person, not the agent. Ask them to run it.'
    }
  }
  return null
}

export const stateKey = (input) => `${String(input.session_id ?? 'session').replace(/\W/g, '')}-${String(input.tool_use_id ?? 'last').replace(/\W/g, '')}`

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const input = await readInput()
  const root = projectRoot(input)
  const tool = input.tool_name
  const why = check(root, tool, input.tool_input ?? {})
  if (why) {
    try {
      journal(root, tool, inRepo(root, input.tool_input?.file_path) ?? input.tool_input?.command ?? '', `blocked: ${why}`)
    } catch {
      // A journal that cannot be written must not turn a block into an allow.
    }
    process.stderr.write(`Fig blocked this: ${why}\n`)
    process.exit(2)
  }
  if (tool === 'Bash') {
    // Remember legacy/ as it was, so the after-command check can tell if
    // something this guard did not recognise wrote to it.
    const dir = join(tmpdir(), 'fig-hooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, stateKey(input)), legacyHash(root))
  }
}
