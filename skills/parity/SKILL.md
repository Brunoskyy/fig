---
name: parity
description: Replay recorded legacy traffic for a route against the new service and triage every difference. Use after porting, after any change under service/, and before flipping a route.
argument-hint: <route name, or nothing for all routes>
allowed-tools: Read, Grep, Glob, Bash(npm run parity*), Bash(npm run record*), Bash(npm run report*), Edit
---

# Parity for $ARGUMENTS

1. Run `npm run parity -- $ARGUMENTS`. It replays `parity/golden/<route>.json` against a fresh service with the frozen clock and writes `migration/parity/<route>.json` and the page `migration/parity/index.html`.
2. If it says the corpus changed since recording, run `npm run record -- $ARGUMENTS` first. Recording only ever talks to legacy.
3. For each case marked `different`, read the diff paths. Then put it in one of three buckets:
   - **Port bug**: the service is wrong. Find the legacy lines (`npm run index:query -- "<the rule>"`), fix the service, rerun.
   - **Intentional change**: the plan for the route says this quirk is fixed. Add the case under `accepted:` in the corpus with the reason and the Q number, rerun. The route then goes to shadow mode, not straight to the service.
   - **Volatile field**: a value that changes on every run (a timestamp from a real clock, a random id). Add its exact JSON path to `ignore:`. Do this rarely. Every ignored path is printed in the report, and a path that hides a rule is a port bug in disguise.
4. Never edit `parity/golden/` by hand and never re-record to make a diff go away. The recording is what legacy does.
5. Report back: the PASS or FAIL line per route, each case that is not `same` with its bucket, and what you changed.
