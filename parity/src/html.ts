import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { REPORT_DIR, ROOT, routes, serviceHash } from './corpus.ts'
import type { ParityReport } from './harness.ts'
import { reportFile } from './harness.ts'

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v))

const STYLE = `
:root { --bg:#fbfaf7; --fg:#1d2321; --muted:#68716d; --line:#e4e1d8; --card:#fff; --ok:#2f7d4f; --okbg:#e5f3ea; --warn:#9a6a00; --warnbg:#fbf1d9; --bad:#b4372f; --badbg:#fae4e1; --code:#f3f1ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#151917; --fg:#e7ebe8; --muted:#97a19c; --line:#2a312e; --card:#1c2220; --ok:#7fd3a0; --okbg:#1f3a2a; --warn:#f0c463; --warnbg:#3b3018; --bad:#f19a90; --badbg:#432421; --code:#232a27; } }
* { box-sizing: border-box }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 48px }
h1 { font-size: 22px; margin: 0 0 4px } h2 { font-size: 16px; margin: 0 }
.sub { color: var(--muted); margin: 0 0 24px; font-size: 13px }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin: 0 0 16px; overflow: hidden }
.head { display: flex; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap }
.pill { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px }
.pass { background: var(--okbg); color: var(--ok) } .fail { background: var(--badbg); color: var(--bad) } .acc { background: var(--warnbg); color: var(--warn) }
.counts { margin-left: auto; color: var(--muted); font-size: 13px }
table { width: 100%; border-collapse: collapse }
td { padding: 7px 16px; border-top: 1px solid var(--line); vertical-align: top; font-size: 13.5px }
tr:first-child td { border-top: 0 }
td.o { width: 92px } td.m { width: 70px; color: var(--muted) }
.diff { margin: 6px 0 0; padding: 8px 10px; background: var(--code); border-radius: 6px; white-space: pre-wrap; word-break: break-word }
.why { color: var(--warn); font-size: 12.5px; margin-top: 4px }
.meta { padding: 8px 16px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line) }
.stale { color: var(--bad) }
`

function page(title: string, sub: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><h1>${esc(title)}</h1><p class="sub">${sub}</p>${body}</main></body></html>\n`
}

function routeCard(r: ParityReport, currentHash: string): string {
  const rows = r.cases
    .map((c) => {
      const pill = c.outcome === 'same' ? '<span class="pill pass">same</span>' : c.outcome === 'accepted' ? '<span class="pill acc">accepted</span>' : '<span class="pill fail">different</span>'
      const diffs = c.differences.length
        ? `<div class="diff mono">${c.differences
            .slice(0, 8)
            .map((d) => `${esc(d.path)}\n  legacy  ${esc(show(d.legacy))}\n  service ${esc(show(d.service))}`)
            .join('\n')}</div>`
        : ''
      const why = c.reason ? `<div class="why">${esc(c.reason)}</div>` : ''
      return `<tr><td class="o">${pill}</td><td class="m mono">${c.legacy.status}</td><td>${esc(c.name)}${why}${diffs}</td></tr>`
    })
    .join('')
  const stale = r.serviceHash !== currentHash ? ` · <span class="stale">stale: service changed since this ran</span>` : ''
  return `<section class="card"><div class="head"><span class="pill ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span><h2 class="mono">${esc(r.match)}</h2><span class="counts">${r.counts.same} same · ${r.counts.accepted} accepted · ${r.counts.different} different</span></div><table>${rows}</table><div class="meta">ran ${esc(r.ranAt.slice(0, 19).replace('T', ' '))} UTC · service ${esc(r.serviceHash)}${stale} · ignored paths: ${r.ignored.length ? esc(r.ignored.join(', ')) : 'none'}</div></section>`
}

export function writeHtmlReport(): string {
  const current = serviceHash()
  const reports = routes()
    .filter((r) => existsSync(reportFile(r)))
    .map((r) => JSON.parse(readFileSync(reportFile(r), 'utf8')) as ParityReport)
  const total = reports.reduce((n, r) => n + r.cases.length, 0)
  const html = page(
    'Quayside parity',
    `${reports.length} routes · ${total} recorded cases replayed against the new service · legacy answers recorded with the clock frozen at 2016-11-20 10:00 UTC`,
    reports.map((r) => routeCard(r, current)).join(''),
  )
  mkdirSync(REPORT_DIR, { recursive: true })
  const out = join(REPORT_DIR, 'index.html')
  writeFileSync(out, html)
  return relative(ROOT, out)
}

/** Renders migration/journal.md (one table row per tool action) as a page. */
export function writeJournalHtml(): string {
  const file = join(ROOT, 'migration', 'journal.md')
  const rows = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('| ') && !l.startsWith('| time') && !l.startsWith('| ---'))
        .map((l) => l.slice(2, -2).split(' | '))
    : []
  const body = `<section class="card"><table>${rows
    .map(([time, tool, target, note]) => {
      const kind = /blocked/i.test(note ?? '') ? 'fail' : /flip|parity/i.test(`${tool} ${note}`) ? 'acc' : 'pass'
      return `<tr><td class="m mono" style="width:150px">${esc(time ?? '')}</td><td class="o"><span class="pill ${kind}">${esc(tool ?? '')}</span></td><td class="mono">${esc(target ?? '')}${note ? `<div class="why" style="color:var(--muted)">${esc(note)}</div>` : ''}</td></tr>`
    })
    .join('')}</table></section>`
  const out = join(ROOT, 'migration', 'journal.html')
  writeFileSync(out, page('Migration journal', `${rows.length} tool actions logged by the plugin's hooks`, body))
  return relative(ROOT, out)
}
