#!/usr/bin/env node
// PostToolUse for Bash: the backstop behind the guard. If legacy/ changed
// during the command, tell the agent (exit 2 sends stderr back to it) and
// journal it. Nothing is reverted automatically: the person may have
// uncommitted work there, and only they should decide.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stateKey } from './guard.mjs'
import { journal, legacyHash, projectRoot, readInput } from './lib.mjs'

const input = await readInput()
const root = projectRoot(input)
const file = join(tmpdir(), 'fig-hooks', stateKey(input))
if (existsSync(file)) {
  const before = readFileSync(file, 'utf8')
  rmSync(file, { force: true })
  if (before !== legacyHash(root)) {
    journal(root, 'Bash', input.tool_input?.command ?? '', 'legacy/ changed during this command')
    process.stderr.write(
      'Fig: legacy/ changed during that command. Fig never edits the legacy system: undo it (git diff legacy/, then git checkout -- <file>) and port the behaviour into service/ instead.\n',
    )
    process.exit(2)
  }
}
