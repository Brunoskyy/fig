#!/usr/bin/env node
// PreToolUse guard. Exit code 2 blocks the tool call and shows stderr to
// the agent, which is how Claude Code hooks refuse an action. Any other
// failure would let the call through, so everything that can fail, the
// imports included, runs inside the try and ends in exit 2.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root
let tool
let input
let why
let lib
try {
  lib = await import('./lib.mjs')
  const { check } = await import('./policy.mjs')
  input = await lib.readInput()
  root = lib.projectRoot(input)
  tool = input.tool_name
  why = check(root, tool, input.tool_input ?? {})
  if (!why && tool === 'Bash') {
    // Remember the protected state as it was, so the after-command check
    // can tell if something this guard did not recognise changed it.
    const dir = join(tmpdir(), 'fig-hooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, lib.stateKey(input)), JSON.stringify(lib.protectedState(root)))
  }
} catch (e) {
  why = `the Fig guard failed (${e.message}), so the action is refused until that is fixed`
}
if (why) {
  try {
    lib?.journal(root, tool, lib.inRepo(root, input?.tool_input?.file_path) ?? input?.tool_input?.command ?? '', `blocked: ${why}`)
  } catch {
    // A journal that cannot be written must not turn a block into an allow.
  }
  process.stderr.write(`Fig blocked this: ${why}\n`)
  process.exit(2)
}
