# GET /api/v1/bookings/:id

A plain lookup with one deliberate change, used to prove shadow mode.

## Legacy behaviour
- Looks the booking up by `parseInt(id)`, so `2abc` finds booking 2 and `latest` finds nothing (legacy/app.js:384-385).
- Found: `200 { ok: true, booking }` with `cancelled` and `fee` turned into null when empty (legacy/app.js:388, 217-227). An empty-string `cancelled_at`, which exists in old rows, also comes back as null because of `||`.
- Missing: `200 { ok: false, err: "NOT_FOUND" }` (legacy/app.js:382-387).

## Quirks
- Q9 fixed: a missing booking answers `404 { error: { code: "NOT_FOUND", message } }`. The partner portal treats 200 as success and has shown empty booking pages because of it.

## Parity cases
- existing: confirmed, cancelled with fee, empty `cancelled_at` row, trailing junk id.
- accepted: missing booking, non-numeric id. Both are the Q9 fix and listed under `accepted` with the reason.

## Target
Module service/src/bookings/. Mode after porting: shadow. The mobile app reads `ok`, not the status code; it ships a fix in its next release, and the shadow log shows what the change would do to real traffic until then.

## Approval
