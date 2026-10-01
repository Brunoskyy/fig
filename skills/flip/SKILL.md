---
name: flip
description: Send a ported route's traffic to the new service (or to shadow mode) by editing edge/routes.yaml. The guard hook only allows it when the plan's approval matches its text and parity passes when the guard runs it.
argument-hint: <route name> [shadow]
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(npm run parity*), Bash(npm test*)
---

# Flip: $ARGUMENTS

1. Find the route's `match` in `parity/corpus/<route>.yaml` and its plan in `migration/routes/<route>.md`.
2. Run `npm run parity -- <route>` and read the report. The guard does not take the report's word for it: on the flip it records legacy again, checks the recording still matches, and replays the service itself.
3. Pick the mode:
   - `service` when every case is `same`, or when the only accepted differences are ones callers already handle.
   - `shadow` when the plan fixes a quirk that callers might notice, or when you were asked for shadow. The legacy app keeps answering and the edge logs every difference to `migration/shadow/`. Shadow works only for GET and HEAD routes.
4. Edit `edge/routes.yaml` with the Edit tool (not the shell, which the guard refuses for this file). Add or change one entry:

   ```yaml
   - match: 'GET /api/v1/ports'
     to: service
     note: parity 8/8 on <date>
   ```

5. If the guard blocks the edit, it says why: no corpus, a plan approval that no longer matches the plan, or parity failing when run now. Fix that, or ask the person to re-approve. Do not work around the guard.
6. Update the route's `state` in `migration/plan.md`. Going back is always allowed: set `to: legacy`.
