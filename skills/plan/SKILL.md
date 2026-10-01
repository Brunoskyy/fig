---
name: plan
description: Write the migration plan for one legacy route, citing the legacy lines for every rule through the index, listing the parity cases needed, and stopping for the person's approval. Use before porting a route.
argument-hint: <route name, e.g. quote>
allowed-tools: Read, Grep, Glob, Bash(npm run index:*), Write, Edit
---

# Plan one route: $ARGUMENTS

The plan is a contract between the person and the port. Every rule the new code implements must trace to legacy lines, and every line that matters must be covered by a parity case.

## Steps

1. Find the route in `migration/plan.md`. If it is not there, run `/fig:survey` first.
2. Ask the index about each behaviour, in plain words and with names from the code, e.g. `npm run index:query -- "minimum dangerous goods charge"`. Read every chunk it returns before you cite it. Cite as `legacy/app.js:<start>-<end>`, as narrow as the rule allows.
3. Follow the call graph: helpers the handler calls (date parsing, lookups, flag parsing) carry rules too. A port that misses a helper's quirk will fail parity in ways that are hard to read.
4. For each quirk from `legacy/QUIRKS.md` that touches the route, say whether the port keeps it or fixes it. A fix is a visible behaviour change, so it needs a reason, and the route goes to shadow mode first.
5. List the parity cases: one per rule, one per boundary (exactly at a limit and one past it), one per validation message, and malformed input. Name existing cases in `parity/corpus/<route>.yaml` and the ones to add.

## Write migration/routes/$ARGUMENTS.md

```
# <METHOD path>

## Legacy behaviour
- <rule in one sentence> (legacy/app.js:a-b)

## Quirks
- Q<n> <kept|fixed>: <why>

## Parity cases
- existing: <case name>
- add: <case name>: <request>

## Target
Module service/src/<module>/, following the golden route (GET /api/v1/ports).
Mode after porting: <service | shadow, and why>

## Approval
```

Leave the Approval section empty. Approval is the person's: tell them the plan is ready and that they approve it by running `npm run approve -- $ARGUMENTS` themselves (in Claude Code, `! npm run approve -- $ARGUMENTS`). The hooks block you from writing an `Approved-by:` line or running that command, so do not try.
