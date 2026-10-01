---
name: port
description: Implement an approved route plan in the NestJS service, following the golden route, then record and run parity. Use after /fig:plan has been approved.
argument-hint: <route name, e.g. quote>
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(npm run *), Bash(npx vitest *), Bash(npx tsc *)
---

# Port a route: $ARGUMENTS

## Before writing code

1. Open `migration/routes/$ARGUMENTS.md`. It must end with an `Approved-by:` line. If it does not, stop and ask the person to review it. Do not port from an unapproved plan.
2. Read the golden route end to end: `service/src/ports/` (module, controller) and how it is wired in `service/src/app.ts`. Match its shape. It is the reference for naming, injection with explicit `@Inject(token)` (the build has no decorator metadata), and error handling through `service/src/common/legacy-errors.ts`.
3. Read every legacy line the plan cites. The plan is a map, not a substitute.

## Writing the port

- One Nest module per resource: `<name>.module.ts`, controller, and a service when there are rules. Pure rules (pricing, fees, dates) go in plain functions with no Nest imports, so tests can call them directly.
- Validate input in the same order and with the same messages as legacy. The order is observable: the first error wins.
- Keep the legacy arithmetic when the plan keeps a quirk: same float operations in the same order, same rounding, same `toFixed` strings. Put each constant in one named place with a comment that cites the legacy line.
- Kept quirks get a comment with their Q number. Fixed quirks get a comment saying what changed and why.
- Errors: throw the classes from `legacy-errors.ts` so the response matches the legacy format byte for byte. Do not invent a new error shape for a route that is meant to be identical.
- Never edit `legacy/`. If the legacy code looks wrong, the plan says whether to keep it.

## Proving it

1. Add the plan's new cases to `parity/corpus/$ARGUMENTS.yaml`, then `npm run record -- $ARGUMENTS` (this asks legacy, never the service).
2. `npm run parity -- $ARGUMENTS`. Fix the service until it passes; never change a recording to match the service.
3. Add unit tests for the pure rules under `test/`, `npm test`, `npm run typecheck`, `npm run lint`.
4. Ask the `rule-auditor` agent to review the port against the plan's citations.
5. Update the route's `state` in `migration/plan.md` to `ported`. Flipping is a separate step: `/fig:flip $ARGUMENTS`.
