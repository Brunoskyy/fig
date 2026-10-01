// Shared by the hook scripts. Plain JavaScript on purpose: hooks run on
// every tool call, so they must start fast and need no build step.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

export async function readInput() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() ? JSON.parse(text) : {}
}

/** The repository being migrated: the session's project, else the working directory. */
export function projectRoot(input) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())
}

/**
 * The path as the file system sees it: symlinks followed (dangling ones too)
 * and, on a case-insensitive disk, the real case of every existing part. A
 * lexical check alone lets `Legacy/app.js` or a link into legacy/ through.
 */
export function canonical(abs, depth = 0) {
  let head = abs
  const tail = []
  for (;;) {
    try {
      if (lstatSync(head).isSymbolicLink() && depth < 20) {
        const target = resolve(dirname(head), readlinkSync(head))
        return canonical(join(target, ...tail), depth + 1)
      }
      return join(realpathSync.native(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return abs
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** Repo-relative canonical path with forward slashes, or null when the path is outside the repo. */
export function inRepo(root, file, cwd = root) {
  if (!file) return null
  const abs = isAbsolute(file) ? resolve(file) : resolve(cwd, file)
  const rel = relative(canonical(resolve(root)), canonical(abs))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** Whether a repo-relative path is `dir` or inside it, ignoring case (macOS and Windows disks ignore it too). */
export const under = (rel, dir) => rel !== null && (rel.toLowerCase() === dir || rel.toLowerCase().startsWith(`${dir}/`))

/** Directories nobody hand-edits and that are too big to hash on every tool call. */
const SKIP = new Set(['node_modules', '.git'])

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(p)
    // A symlink is hashed as the link it is, never followed: a link to a
    // directory would otherwise be read as a file.
    return e.isFile() || e.isSymbolicLink() ? [p] : []
  })
}

const contentOf = (f) => (lstatSync(f).isSymbolicLink() ? `symlink:${readlinkSync(f)}` : readFileSync(f))

/** Same hash as parity/src/corpus.ts hashFiles (a test keeps the two in step). */
export function hashFiles(root, files) {
  const h = createHash('sha256')
  for (const f of [...files].sort()) h.update(relative(root, f)).update('\0').update(contentOf(f)).update('\0')
  return h.digest('hex').slice(0, 16)
}

export const serviceHash = (root) => hashFiles(root, walk(join(root, 'service', 'src')))

const dirHash = (root, dir) => (existsSync(join(root, dir)) ? hashFiles(root, walk(join(root, dir))) : 'none')

/** Fingerprint of everything under legacy/, to notice writes no pattern caught. */
export const legacyHash = (root) => dirHash(root, 'legacy')

const APPROVAL_LINE = /^(Approved-by|Plan-hash):.*$/gm

/** The lines a person signs a plan with. */
export const approvalLines = (text) => text.match(APPROVAL_LINE) ?? []

/**
 * What an approval vouches for: the plan without its approval lines, with
 * line endings and trailing space normalised. `npm run approve` records it
 * as `Plan-hash: sha256:<hash>` next to the person's `Approved-by` line.
 */
export function planHash(text) {
  const body = text.replace(/\r\n/g, '\n').replace(APPROVAL_LINE, '').replace(/\s+$/, '')
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** Why a plan does not count as approved as it stands, or null when it does. */
export function approvalProblem(text) {
  if (!/^Approved-by:/m.test(text)) return 'it has no Approved-by line'
  const hashes = [...text.matchAll(/^Plan-hash: sha256:([0-9a-f]+)\s*$/gm)].map((m) => m[1])
  if (!hashes.length) return 'its approval does not say which text was approved (no Plan-hash line)'
  if (hashes.at(-1) !== planHash(text)) return 'it changed after it was approved'
  return null
}

/**
 * The state the after-command check compares: legacy/, routes.yaml, plan
 * approvals (and the whole text of approved plans), the corpus sign-offs and
 * the gate's own code. Recordings and reports are not in it: the flip check
 * does not trust them, it makes them again.
 */
export function protectedState(root) {
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '')
  const list = (dir, ext) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir))
          .filter((f) => f.endsWith(ext))
          .sort()
      : []
  const plans = list('migration/routes', '.md').map((f) => {
    const text = read(`migration/routes/${f}`)
    return [f, /^Approved-by:/m.test(text) ? text : approvalLines(text).join('\n')]
  })
  const signoffs = list('parity/corpus', '.yaml').map((f) => [f, corpusSignoffs(read(`parity/corpus/${f}`))])
  const h = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
  return {
    'legacy/': legacyHash(root),
    'edge/routes.yaml': h(read('edge/routes.yaml')),
    'plan approvals in migration/routes/': h(plans),
    'accepted and ignore in parity/corpus/': h(signoffs),
    'parity/src/': dirHash(root, 'parity/src'),
    'hooks/': dirHash(root, 'hooks'),
  }
}

/** The parts of a corpus that only a person signs off: accepted differences and ignored paths. */
export function corpusSignoffs(text) {
  try {
    const doc = parse(text) ?? {}
    return JSON.stringify({ accepted: doc.accepted ?? [], ignore: doc.ignore ?? [] })
  } catch {
    return `unparsable:${text}`
  }
}

/** Identifies a hook run, so the before and after halves of one Bash call find each other. */
export const stateKey = (input) => `${String(input.session_id ?? 'session').replace(/\W/g, '')}-${String(input.tool_use_id ?? 'last').replace(/\W/g, '')}`

/**
 * Splits a shell command into simple commands and their words, honouring
 * quotes and backslashes, so `sed -i 's/a;b/c/' legacy/x` is one command
 * whose last word is `legacy/x`. Redirect targets are returned separately.
 * It is a guardrail, not a shell: `node -e`, `eval` and friends can still
 * write anywhere, which is what the after-command check is for.
 */
export function parseShell(command) {
  const commands = []
  let words = []
  let redirects = []
  let word = ''
  let inWord = false
  let quote = null
  let pendingRedirect = false
  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect) redirects.push(word)
    else words.push(word)
    pendingRedirect = false
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length || redirects.length) commands.push({ words, redirects })
    words = []
    redirects = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      endCommand()
    } else if (c === '>') {
      endWord()
      if (command[i + 1] === '>') i += 1
      if (command[i + 1] === '&' || command[i + 1] === '|') i += 1
      pendingRedirect = true
    } else if (c === '<') {
      endWord()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

const WRITERS = {
  tee: 'args',
  rm: 'args',
  rmdir: 'args',
  mv: 'args',
  touch: 'args',
  truncate: 'args',
  chmod: 'args',
  patch: 'args',
  unlink: 'args',
  cp: 'last',
  install: 'last',
  ln: 'last',
  rsync: 'last',
  sponge: 'args',
  ed: 'args',
  ex: 'args',
}

const IN_PLACE = /^-[a-zA-Z]*i|^--in-place|^--inplace/

/**
 * Paths a command would write, best effort, each with the directory the
 * shell would be in by then: `cd edge && sed -i ... routes.yaml` writes
 * edge/routes.yaml. After a `cd` it cannot follow (`cd -`, `cd $X`) the
 * directory is null and the caller decides.
 */
export function shellWrites(command, root = '.') {
  const out = []
  let cwd = resolve(root)
  const add = (path) => out.push({ path, cwd: isAbsolute(path) ? resolve(root) : cwd })
  for (const { words, redirects } of parseShell(command)) {
    for (const r of redirects) if (!/^&?\d*$/.test(r) && r !== '/dev/null') add(r)
    let w = words
    while (w.length && (/^\w+=/.test(w[0]) || ['sudo', 'env', 'command', 'xargs', 'nohup', 'time', 'exec'].includes(w[0]))) w = w.slice(1)
    const [cmd, ...args] = w
    if (!cmd) continue
    const name = cmd.split('/').pop()
    if (name === 'cd' || name === 'pushd') {
      const to = args.find((a) => !a.startsWith('-'))
      cwd = to === undefined || to === '-' || /[$`~]/.test(to) || cwd === null ? null : resolve(cwd, to)
      continue
    }
    const paths = args.filter((a) => !a.startsWith('-'))
    if (WRITERS[name] === 'args') paths.forEach(add)
    else if (WRITERS[name] === 'last') paths.slice(-1).forEach(add)
    else if (['sed', 'perl', 'ruby', 'yq'].includes(name) && args.some((a) => IN_PLACE.test(a))) paths.forEach(add)
    else if (name === 'awk' || name === 'gawk') {
      if (args.includes('inplace')) paths.forEach(add)
    } else if (['prettier', 'eslint'].includes(name) || (['npx', 'pnpx'].includes(name) && ['prettier', 'eslint'].includes(paths[0]))) {
      if (args.some((a) => a === '--write' || a === '-w' || a.startsWith('--fix'))) paths.forEach(add)
    } else if (name === 'dd') args.filter((a) => a.startsWith('of=')).forEach((a) => add(a.slice(3)))
    else if (name === 'git' && ['checkout', 'restore', 'apply', 'reset', 'mv', 'rm', 'clean', 'stash'].includes(paths[0]))
      (paths.length > 1 ? paths.slice(1) : ['.']).forEach(add)
  }
  return out
}

/** Maps a routes.yaml `match` to its parity corpus name. */
export function corpusFor(root, match) {
  const dir = join(root, 'parity', 'corpus')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const corpus = parse(readFileSync(join(dir, f), 'utf8'))
    if (corpus?.match === match) return f.replace(/\.yaml$/, '')
  }
  return null
}

/**
 * Why a route may not be sent to the service yet, or null when it may. The
 * plan must carry an approval bound to its current text, and parity must
 * pass when run now: the recording is made again from legacy and must equal
 * the committed one, then the service is replayed against it. Reports and
 * recordings on disk are files anyone with write access can produce, so
 * they are not trusted.
 */
export function flipBlocker(root, match, run = runVerify) {
  const route = corpusFor(root, match)
  if (!route) return `${match} has no parity corpus in parity/corpus/, so nothing proves it matches legacy`
  const plan = join(root, 'migration', 'routes', `${route}.md`)
  if (!existsSync(plan)) return `${match} has no plan at migration/routes/${route}.md`
  const problem = approvalProblem(readFileSync(plan, 'utf8'))
  if (problem)
    return `the plan migration/routes/${route}.md is not approved as it stands: ${problem}. Ask the person to review it and run npm run approve -- ${route}`
  const verdict = run(root, route)
  if (!verdict.passed) return `parity for ${match} does not pass when run now: ${verdict.why ?? 'unknown reason'}. Run npm run parity -- ${route}`
  return null
}

/** Runs parity/src/cli/verify.ts for a route in a child process and returns its verdict. */
export function runVerify(root, route) {
  let tsx
  try {
    tsx = createRequire(join(root, 'package.json')).resolve('tsx')
  } catch {
    return { passed: false, why: 'tsx is not installed in the project (npm install)' }
  }
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(tsx).href, join(root, 'parity', 'src', 'cli', 'verify.ts'), route], {
    cwd: root,
    encoding: 'utf8',
    timeout: 100_000,
    env: { ...process.env, QUAYSIDE_QUIET: '1' },
  })
  const last =
    String(run.stdout ?? '')
      .trim()
      .split('\n')
      .at(-1) ?? ''
  try {
    const verdict = JSON.parse(last)
    return { passed: verdict.passed === true && run.status === 0, why: verdict.why }
  } catch {
    return {
      passed: false,
      why: run.error
        ? run.error.message
        : `the check exited ${run.status}: ${String(run.stderr ?? '')
            .trim()
            .slice(-300)}`,
    }
  }
}

/** Same identity as edge/src/routes.ts routeKey: parameter names do not make a different route. */
export function routeKey(match) {
  const [method, path = ''] = String(match).split(' ')
  const segments = path
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':' : seg))
  return `${method} ${segments.join('/') || '/'}`
}

/** Route -> target. A route listed twice is refused, as the edge refuses it: the edge reads the first, a map the last. */
const targets = (text) => {
  const doc = parse(text) ?? {}
  const out = new Map()
  const keys = new Set()
  for (const r of doc.routes ?? []) {
    const key = routeKey(r.match)
    if (keys.has(key)) throw new Error(`${r.match} is listed twice`)
    keys.add(key)
    out.set(r.match, r.to)
  }
  return out
}

/** Changes to routes.yaml that move traffic without a per-route flip: the default and the upstreams. */
export function globalChanges(before, after) {
  const a = parse(before) ?? {}
  const b = parse(after) ?? {}
  const out = []
  if ((b.default ?? 'legacy') !== (a.default ?? 'legacy')) out.push(`default ${a.default ?? 'legacy'} -> ${b.default ?? 'legacy'}`)
  if (JSON.stringify(b.upstreams ?? {}) !== JSON.stringify(a.upstreams ?? {})) out.push('upstreams')
  return out
}

/** Routes whose target becomes `service` between two versions of routes.yaml. */
export function flips(before, after) {
  const old = targets(before)
  return [...targets(after)].filter(([match, to]) => to === 'service' && old.get(match) !== 'service').map(([match]) => match)
}

/** The file content an Edit, MultiEdit or Write would leave behind. */
export function contentAfter(tool, input, current) {
  if (tool === 'Write') return input.content ?? ''
  const edits = tool === 'MultiEdit' ? (input.edits ?? []) : [input]
  let text = current
  for (const e of edits) {
    if (e.old_string === undefined) continue
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string)
  }
  return text
}

const JOURNAL_HEAD =
  '# Migration journal\n\nWritten by the Fig hooks: one row per tool call in a session with the plugin loaded.\n\n| time | tool | target | note |\n| --- | --- | --- | --- |\n'

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)

/** Local paths stay out of the journal, which gets committed: the project root becomes `.`. */
export const scrub = (root, s) =>
  String(s ?? '')
    .split(root)
    .join('.')

export function journal(root, tool, target, note = '') {
  const file = join(root, 'migration', 'journal.md')
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, JOURNAL_HEAD)
  const time = new Date().toISOString().slice(0, 19).replace('T', ' ')
  appendFileSync(file, `| ${time} | ${cell(tool)} | ${cell(scrub(root, target))} | ${cell(scrub(root, note))} |\n`)
}

/** What a tool call acted on, in a few words. */
export function describeTarget(root, tool, input = {}) {
  if (input.file_path) return inRepo(root, input.file_path) ?? input.file_path
  if (input.notebook_path) return inRepo(root, input.notebook_path) ?? input.notebook_path
  if (tool === 'Bash') return input.command ?? ''
  if (input.pattern) {
    const where = input.path ? (inRepo(root, input.path) ?? input.path) : ''
    return where ? `${input.pattern} in ${where}` : input.pattern
  }
  if (input.skill) return `/${input.skill}${input.args ? ` ${input.args}` : ''}`
  if (input.subagent_type) return `${input.subagent_type}: ${input.description ?? ''}`
  if (input.url) return input.url
  return Object.keys(input).slice(0, 3).join(', ')
}
