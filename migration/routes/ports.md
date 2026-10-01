# GET /api/v1/ports

The golden route: the first one ported, chosen because it has almost no rules. `/fig:port` points at it as the shape to copy.

## Legacy behaviour
- Lists every port, ordered by name (legacy/app.js:253-261).
- `?region=` filters by region after uppercasing it; an empty value means no filter (legacy/app.js:255-258).
- A repeated `?region=` arrives as an array, stringifies to `"EU,AS"`, and matches nothing (Express query parsing, legacy/app.js:257).
- Body is `{ ok, count, ports }` (legacy/app.js:262).
- `?callback=` that is a valid JS identifier answers JSONP as `application/javascript`; anything else is ignored and the answer is JSON (legacy/app.js:263-268).

## Quirks
- Q10 kept: the old agents portal still loads ports with a script tag.

## Parity cases
- existing: all 13 in `parity/corpus/ports.yaml`, including the invalid callback, the repeated region, and the bracketed and nested query keys added after review.

## Target
Module service/src/ports/. Mode after porting: service.

## Approval

Approved-by: Artur Bruno on 2026-10-01
Plan-hash: sha256:f96d6c9989ff64e1

Approved-by: Artur Bruno on 2026-10-01
Plan-hash: sha256:3f5dd49f952f96c8
