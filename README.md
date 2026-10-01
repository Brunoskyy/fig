<p align="center">
  <img src="docs/logo.svg" width="76" alt="">
</p>

<h1 align="center">Fig</h1>

<p align="center">
  Fig, a refactor toolkit for legacy backends.<br>
  <sub>Claude Code plugin · TypeScript · NestJS · Express · node:sqlite · Vitest · transformers.js</sub>
</p>

<br>

The name comes from the strangler fig, which grows around a tree until it replaces it. The
pattern named after it migrates a legacy backend the same way: a proxy sits in front, routes move
to the new service one at a time, and each move is reversible. Rewriting in one go fails because
nobody knows everything the old code does; the rules live in handlers, in a `<=` that should have
been `<`, in a rounding step finance reconciles against.

Fig is that process as a Claude Code plugin, with the parts that make it safe to hand to an
agent: a parity harness that records what legacy answers and replays it against the new code,
hooks that keep the agent off the legacy code and refuse a flip unless parity passes, and a
local search index so every rule in a plan cites its lines, with an eval of how often it finds
the right ones.

The legacy system is in the repo. **Quayside** is a fictional 2014-style shipping-quote API, 473
lines in one `app.js` with raw SQL, float dollars and twelve documented quirks. Three of its 11
routes are migrated: two serve from the new service, one runs in shadow mode.

<p align="center">
  <img src="docs/screenshots/parity-light.png" width="49%" alt="Parity report: bookings by id passes with four same cases and two accepted differences, each showing the 200 vs 404 diff">
  <img src="docs/screenshots/journal-light.png" width="49%" alt="Migration journal: flips of routes.yaml, a legacy edit that got through, and two later attempts blocked by the guard">
</p>

## Running it

You need Node 24 (`nvm use` reads the `.nvmrc`), and Claude Code for the plugin. No database or
Docker: everything uses `node:sqlite` files under `data/`.

1. Clone and install:

   ```bash
   git clone https://github.com/Brunoskyy/fig.git && cd fig
   nvm use
   npm install
   ```

2. From the repo root, each of these runs and exits on its own:

   ```bash
   npm run parity          # replay recorded legacy traffic against the service, all routes
   npm run demo:shadow     # legacy, service and edge as real processes, traffic through the edge
   npm run hooks:dry-run   # feed the guard the tool calls Claude Code would send
   FIG_ALLOW_DOWNLOAD=1 npm run index:query -- "what does it cost to cancel five days before sailing?"
   npm run index:eval      # writes index/eval/runs/<date>.json and RESULTS.md
   ```

   `npm run parity` rewrites the reports in `migration/parity/`. The first index command
   downloads the embedding model (33 MB) into `~/.cache/fig-models`; after that,
   `FIG_ALLOW_DOWNLOAD` is not needed.

3. To load the plugin, from the repo root:

   ```bash
   claude --plugin-dir .
   ```

   That lists `/fig:survey`, `/fig:plan`, `/fig:port`, `/fig:parity` and `/fig:flip`, plus the
   `fig:rule-auditor` agent, and turns on the hooks for that session.

To run the pieces by hand, use three terminals from the repo root: `npm run legacy` (port 4100),
`npm run service` (4200) and `npm run edge` (4000, the one to call). Stop each with Ctrl+C. They
share `data/quayside.db`; delete `data/` to reset it.

| Command (repo root) | |
| --- | --- |
| `npm test` | 81 tests |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` and ESLint |
| `npm run approve -- <route>` | approve a plan; only you run this |

## How it works

<p align="center">
  <img src="docs/architecture.svg" width="100%" alt="Callers go to the edge, which routes to legacy, the service, or both in shadow mode. Both use one SQLite database. Parity and the index sit beside them, and the plugin drives the workflow.">
</p>

**The edge** (`edge/`) is about 300 lines on `node:http`. Each route in `edge/routes.yaml` goes to
`legacy`, `service` or `shadow`. In shadow mode the caller gets the legacy answer and the
service's answer is diffed into `migration/shadow/`. Shadow is refused for writes, because both
sides share one database and the write would happen twice.

**Parity** (`parity/`) is characterization testing. A corpus per route lists requests, one or
more per rule and boundary. `npm run record` sends them to legacy on a fresh seeded database with
the clock frozen, and `npm run parity` replays them against the service and compares status,
content type and JSON bodies, where `1982` and `"1982"` differ. `accepted:` entries pin an
intentional change to its exact status, paths and error code, so any drift fails again.

**The index** (`index/`) cuts `legacy/app.js` along its acorn AST, one chunk per route handler,
function and run of constants, and SQL per statement. Search is BM25, bge-small cosine
similarity, or both fused with reciprocal rank fusion (k = 60). `QUIRKS.md` is not indexed,
because it restates the rules in plain words.

**The plugin** (`.claude-plugin/`, `skills/`, `agents/`, `hooks/`) is the workflow:

| step                  | what it does                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/fig:survey`         | inventories routes, rules and quirks into `migration/plan.md`                                              |
| `/fig:plan <route>`   | writes `migration/routes/<route>.md`, citing legacy lines found through the index, then stops for approval |
| `/fig:port <route>`   | refuses an unapproved plan, then ports by following the golden route and records and runs parity           |
| `/fig:parity <route>` | replays and sorts each difference into a port bug, an intentional change or a volatile field               |
| `/fig:flip <route>`   | edits `edge/routes.yaml` (only you can invoke it)                                                          |
| `rule-auditor`        | checks each cited rule is present, the same and covered by a parity case                                   |

The hooks enforce what the skills only ask for:

- **No edits under `legacy/`:** Edit and Write through symlinks and any letter case, and shell
  commands through a quote-aware parser (`sed -i`, redirects, `cp`, `mv`, `cd`). A post-command
  hash check catches what the parser can't see, such as `node -e`.
- **No forged evidence:** the agent can't write recordings, reports, the harness or the hooks,
  and `accepted:` entries are the person's call.
- **No flip without proof:** sending a route to `service` makes the guard record legacy again and
  replay the service itself, instead of trusting a report. It fails closed.
- **No self-approval:** `npm run approve` stores who approved and a hash of the plan, an edited
  plan stops counting, and the agent can't run the script. You run it yourself
  (`! npm run approve -- quote`).
- **A journal:** every tool call goes to `migration/journal.md`; `npm run report` renders it as HTML.

## The worked migration

| route                                  | state   | parity             |
| -------------------------------------- | ------- | ------------------ |
| `GET /api/v1/ports` (the golden route) | service | 13 same            |
| `POST /api/v1/quote`                   | service | 34 same            |
| `GET /api/v1/bookings/:id`             | shadow  | 4 same, 2 accepted |

Quote holds most of the rules: a reverse-lane surcharge, weight steps, peak season ending a day
before the rate card says, and round-up-to-5-cents float arithmetic. The port reproduces all of
it, and `test/pricing.test.ts` runs both `price()` functions on 5,000 generated quotes and
requires identical output. Bookings by id fixes quirk Q9: a missing booking was
`200 {"ok": false}` and is now a 404, accepted in the corpus, and the route stays in shadow until
the mobile app reads status codes.

Everything in `migration/` comes from real Claude Code sessions with the plugin loaded. In one,
the guard missed a legacy edit: a `sed -i` whose script contained a `;`, which my first matcher
split on. The journal keeps that row, and the rows after the fix show the same request blocked
twice.

## Index eval

44 questions with the line ranges that answer them: 32 in business words only, checked by a test
never to use a name or four copied words from the code, and 12 typed after seeing a name in a
stack trace. A hit is a top-5 chunk overlapping a gold range.

| mode    | plain recall@5 | plain MRR | code recall@5 | code MRR | all recall@5 | all MRR |
| ------- | -------------- | --------- | ------------- | -------- | ------------ | ------- |
| keyword | 0.344          | 0.276     | 1.000         | 0.875    | 0.523        | 0.439   |
| vector  | 0.703          | 0.628     | 0.750         | 0.625    | 0.716        | 0.627   |
| hybrid  | 0.719          | 0.454     | 0.917         | 0.833    | 0.773        | 0.558   |

Hybrid has the best recall overall, but keyword wins on the code set and vector ranks plain
questions higher, because RRF weighs a confused keyword list as much as a good vector one. I left
that as measured rather than tune weights against the same 44 questions.

## Things worth opening

- **`hooks/policy.mjs`:** turns an Edit into the file it would leave behind and diffs
  `routes.yaml` to find flips. The shell parser's comment says plainly what it can't do.
- **`parity/src/harness.ts`:** record, replay, and what "accepted" has to match.
- **`service/src/quotes/pricing.ts`:** legacy arithmetic reproduced on purpose, each kept quirk
  tagged with its number in `legacy/QUIRKS.md`.
- **`parity/corpus/quote.yaml`:** the rules as requests, with setup SQL for a lane cheap enough to
  hit the $95 hazardous minimum.

## Tests

The 81 tests cover the edge against fake upstreams, parity and its diff (including a rule broken
on purpose that must fail readably), the pricing sweep against legacy, the index chunker, fusion
and eval leakage, and the hooks: shell parsing, forged reports, plans changed after approval,
symlinks, failing closed and the journal.

## Layout

```
legacy/          Quayside 1.9.3: app.js, server.js, db/schema.sql, db/seed.sql, QUIRKS.md
service/src/     NestJS: ports (golden route), quotes, bookings, common (errors, logger, clock), db
edge/            routes.yaml and the strangler proxy
parity/          corpus/ (requests), golden/ (legacy answers), src/ (record, replay, diff, html)
index/           src/ (chunker, BM25, embeddings, fusion), eval/ (questions, runs, RESULTS.md)
.claude-plugin/  plugin manifest
skills/ agents/  /fig:* skills and the rule-auditor agent
hooks/           guard, policy, after-command check, journal, hooks.json
migration/       plan.md, routes/, parity/ reports, shadow/ log, journal.md
scripts/         approve, hook dry run, shadow demo
```

## What's missing

- **Writes are not migrated.** Booking, cancelling and the admin fuel routes stay on legacy;
  shadow can't cover them on a shared database.
- **The shell guard is a guardrail, not a sandbox.** Code run inside an interpreter gets past the
  pre-check; the after-command check notices but doesn't undo.
- **The eval was written by the person who wrote the code.** The leakage test catches names and
  copied phrases, not the bias of knowing where the answer is.
- **No Postgres.** The service and the harness run on `node:sqlite`.
- **CI hasn't run yet.** The workflow is written but not pushed.

MIT licensed.
