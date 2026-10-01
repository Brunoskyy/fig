// What the guard refuses. Kept apart from guard.mjs so that a broken
// import here (a missing dependency, a syntax error) is caught by the
// entry script and turned into a block, never into an allow.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { approvalLines, contentAfter, corpusSignoffs, flipBlocker, flips, globalChanges, inRepo, planHash, shellWrites, under } from './lib.mjs'

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** Areas no agent tool writes, and why. Compared case-insensitively on canonical paths. */
const SEALED = [
  [
    'legacy',
    (rel) =>
      `${rel} is part of the legacy system, which Fig never edits. Port the behaviour into service/ instead; if legacy really has to change, a person does it outside the migration.`,
  ],
  ['parity/golden', (rel) => `${rel} is a recording of what legacy answered. Only npm run record writes it.`],
  ['migration/parity', (rel) => `${rel} is a parity report. Only npm run parity writes it.`],
  ['parity/src', (rel) => `${rel} is the parity harness, which is what proves a port. A person changes it, not the agent.`],
  ['hooks', (rel) => `${rel} is one of the Fig hooks, the guardrails themselves. A person changes them, not the agent.`],
  ['.claude-plugin', (rel) => `${rel} configures the Fig plugin. A person changes it, not the agent.`],
]

const sealed = (rel) => SEALED.find(([dir]) => under(rel, dir))

const isPlan = (rel) => under(rel, 'migration/routes') && rel.toLowerCase().endsWith('.md')
const isCorpus = (rel) => under(rel, 'parity/corpus')
const isRoutes = (rel) => rel?.toLowerCase() === 'edge/routes.yaml'

function checkPlan(root, rel, before, after) {
  const route = rel.split('/').pop().replace(/\.md$/i, '')
  if (approvalLines(after).join('\n') !== approvalLines(before).join('\n')) {
    return `the Approved-by and Plan-hash lines in ${rel} are the person's sign-off and cannot be written by the agent. Ask them to review the plan and run: npm run approve -- ${route}`
  }
  if (/^Approved-by:/m.test(before) && planHash(after) !== planHash(before)) {
    return `${rel} is approved, and the approval covers its text as it is. Tell the person what should change; they edit it and approve it again with npm run approve -- ${route}`
  }
  return null
}

function checkCorpus(rel, before, after) {
  if (corpusSignoffs(after).startsWith('unparsable:')) return `${rel} would no longer parse as YAML`
  if (corpusSignoffs(after) !== corpusSignoffs(before)) {
    return `that edit changes accepted: or ignore: in ${rel}. Those decide which differences from legacy pass, so a person signs them off. Show them the case, the diff and the plan's Q number and let them add it.`
  }
  return null
}

function checkRoutes(root, before, after) {
  let flipped
  let global
  try {
    flipped = flips(before, after)
    global = globalChanges(before, after)
  } catch (e) {
    return `edge/routes.yaml would not be accepted: ${e.message}`
  }
  if (global.length) {
    return `that edit changes ${global.join(' and ')} in edge/routes.yaml, which moves every unlisted route at once. Flip routes one at a time; the default and the upstreams are changed by a person.`
  }
  for (const match of flipped) {
    const why = flipBlocker(root, match)
    if (why) return `cannot send ${match} to the service: ${why}.`
  }
  return null
}

const APPROVE = /scripts\/approve(\.mjs)?\b|\b(npm|pnpm|yarn|bun)\b[^;&|\n]*\bapprove\b/

export function check(root, tool, input) {
  if (FILE_TOOLS.has(tool)) {
    const rel = inRepo(root, input.file_path ?? input.notebook_path)
    if (rel === null) return null
    const hit = sealed(rel)
    if (hit) return hit[1](rel)
    if (!isPlan(rel) && !isCorpus(rel) && !isRoutes(rel)) return null
    const file = join(root, rel)
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = contentAfter(tool, input, before)
    if (isPlan(rel)) return checkPlan(root, rel, before, after)
    if (isCorpus(rel)) return checkCorpus(rel, before, after)
    return checkRoutes(root, before, after)
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    if (APPROVE.test(cmd)) return 'approving a plan is for the person, not the agent. Ask them to run it.'
    for (const { path, cwd } of shellWrites(cmd, root)) {
      if (cwd === null) return `that command changes to a directory the guard cannot follow and then writes ${path}. Use paths from the project root.`
      const rel = inRepo(root, path, cwd)
      if (rel === null) continue
      if (rel === '' || rel === '.') {
        if (/\bgit\b/.test(cmd)) return 'that git command would rewrite the whole tree, legacy/ included. Name the paths outside legacy/ instead.'
        continue
      }
      const hit = sealed(rel)
      if (hit) return `that command writes ${rel}. ${hit[1](rel)}`
      if (isRoutes(rel)) return 'change edge/routes.yaml with the Edit tool, so the flip check can see the change.'
      if (isPlan(rel)) return `change ${rel} with the Edit tool, so the guard can tell a plan edit from an approval.`
      if (isCorpus(rel)) return `change ${rel} with the Edit tool, so the guard can see what it signs off.`
    }
  }
  return null
}
