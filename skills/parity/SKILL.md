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
   - **Intentional change**: the plan for the route says this quirk is fixed. Propose an `accepted:` entry to the person: the case, the status, the differing paths, the reason with the Q number. They add it to the corpus; the guard refuses it from the agent, because it decides what passes. The route then goes to shadow mode, not straight to the service.
   - **Volatile field**: a value that changes on every run (a timestamp from a real clock, a random id). Propose the exact JSON path for `ignore:` to the person, who adds it. This should be rare. Every ignored path is printed in the report, and a path that hides a rule is a port bug in disguise.
4. Never edit `parity/golden/` or `migration/parity/` by hand (the guard refuses it) and never re-record to make a diff go away. The recording is what legacy does, and the flip check records it again to make sure.
5. Report back: the PASS or FAIL line per route, each case that is not `same` with its bucket, and what you changed.
