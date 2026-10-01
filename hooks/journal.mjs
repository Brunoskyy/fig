#!/usr/bin/env node
// PostToolUse: one row in migration/journal.md per tool call. Never fails
// the call it is logging.
import { describeTarget, journal, projectRoot, readInput } from './lib.mjs'

try {
  const input = await readInput()
  const root = projectRoot(input)
  const tool = input.tool_name ?? 'unknown'
  const response = input.tool_response ?? {}
  let note = ''
  if (tool === 'Bash') {
    const code = response.exit_code ?? response.exitCode ?? (response.interrupted ? 'interrupted' : undefined)
    note = code === undefined ? '' : `exit ${code}`
    if (/npm run parity|npm run -s parity/.test(input.tool_input?.command ?? '')) {
      const out = String(response.stdout ?? '')
      note = [
        note,
        ...out
          .split('\n')
          .filter((l) => /^(PASS|FAIL) /.test(l))
          .map((l) => l.split('  ')[0]),
      ]
        .filter(Boolean)
        .join('; ')
    }
  }
  if (response.error) note = `error: ${response.error}`
  journal(root, tool, describeTarget(root, tool, input.tool_input ?? {}), note)
} catch (e) {
  process.stderr.write(`fig journal: ${e.message}\n`)
}
