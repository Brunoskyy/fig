#!/usr/bin/env node
// PostToolUse for Bash: the backstop behind the guard. If legacy/,
// routes.yaml, a plan approval, a corpus sign-off or the gate's own code
// changed during the command, tell the agent (exit 2 sends stderr back to
// it) and journal it. Nothing is reverted automatically: the person may
// have uncommitted work there, and only they should decide.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { journal, projectRoot, protectedState, readInput, stateKey } from './lib.mjs'

const input = await readInput()
const root = projectRoot(input)
const file = join(tmpdir(), 'fig-hooks', stateKey(input))
if (existsSync(file)) {
  const before = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(file, { force: true })
  const after = protectedState(root)
  const changed = Object.keys(after).filter((k) => before[k] !== after[k])
  if (changed.length) {
    journal(root, 'Bash', input.tool_input?.command ?? '', `changed: ${changed.join(', ')}`)
    process.stderr.write(
      `Fig: ${changed.join(', ')} changed during that command. The agent does not write these: undo it (git diff, then git checkout -- <file>) and tell the person what you meant to do.\n`,
    )
    process.exit(2)
  }
}
