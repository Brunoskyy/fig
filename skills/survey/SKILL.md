---
name: survey
description: Inventory a legacy backend before migrating it. Lists every route, the business rules buried in each handler, and the documented quirks, into migration/plan.md. Use at the start of a migration or when the legacy code changed.
allowed-tools: Read, Grep, Glob, Bash(npm run index:*), Write, Edit
---

# Survey the legacy system

You are taking stock of a system that will be replaced route by route. Nothing is changed in this step. The output is `migration/plan.md`, the map every later step works from.

## Steps

1. Build the index so later steps can cite lines: `npm run index:build`.
2. Find every route. Read `legacy/app.js` top to bottom (it is one file on purpose) and list each `app.<verb>(path, ...)` with its line range. Count them; the plan must account for every one.
3. For each route, write down what it does in one sentence, the tables it reads and writes, and the rules it applies. A rule is anything a caller could observe: a surcharge, a rounding step, a validation message and its order, a status code, a header. Cite each rule as `legacy/app.js:<start>-<end>`.
4. Read `legacy/QUIRKS.md`. Map every quirk (Q1, Q2, ...) to the routes it touches and to its decision: kept or fixed. A quirk with no decision is an open question, not a default.
5. Check your citations with the index, e.g. `npm run index:query -- "cancellation fee by days before departure"`. If the index points somewhere you did not cite, read that chunk: either your citation is wrong or there is a second place the rule lives.
6. Order the routes for migration: read-only routes with no rules first, then routes whose rules are already ported elsewhere, then writes. Shadow mode only works for GET and HEAD, so writes need a full corpus before they flip.

## migration/plan.md

Keep this shape so the other skills can read it:

```
# Migration plan

| route | lines | rules | quirks | state | order |
| --- | --- | --- | --- | --- | --- |
| GET /api/v1/ports | legacy/app.js:253-271 | region filter, JSONP | Q10 | service | 1 |
```

`state` is one of `legacy`, `planned`, `ported`, `shadow`, `service`, read from `edge/routes.yaml` and `migration/routes/`. Below the table, one short section per open question.

Do not edit anything under `legacy/`: the hooks block it, and the survey describes the system as it is.
