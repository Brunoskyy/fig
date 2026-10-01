# Quayside quirks

Behaviour of the legacy API that callers depend on. Each one is either
**kept** (the new service reproduces it, and the parity recordings prove it)
or **fixed** (the new service changes it on purpose, and the route stays in
shadow mode until the callers are ready).

| # | Quirk | Where | Decision |
| --- | --- | --- | --- |
| Q1 | A lane priced only one way is quoted the other way at +5%. | `findLane`, `price` | kept |
| Q2 | The weight surcharge starts *above* 20,000 kg: exactly 20,000 is free, then $150 per started 1,000 kg. | `price` | kept |
| Q3 | Weight goes through `parseInt`: `"21500kg"` is 21,500, `"heavy"` is no weight at all (no surcharge, stored as null). | `makeQuote` | kept |
| Q4 | The hazardous surcharge is 18% of base with a $95 minimum, and the gold discount does not apply to it. | `price` | kept |
| Q5 | The rate card says peak season runs Dec 1 to Jan 15, but Jan 15 itself is not peak (`day < 15`). | `isPeak` | kept, finance confirmed partners reconcile against it |
| Q6 | Totals are float dollars rounded **up** to the next 5 cents with `Math.ceil(total * 20) / 20`, so float noise sometimes adds 5 cents. | `price` | kept |
| Q7 | Breakdown amounts are strings (`"2840.00"`), the total is a number. | `price` | kept |
| Q8 | Fuel uses the latest month published on or before the departure month. | `fuelFor` | kept |
| Q9 | Lookups that miss answer `200 {"ok": false, "err": "NOT_FOUND"}`. | every `GET /:id` | fixed for bookings: the new service answers `404` |
| Q10 | `GET /api/v1/ports?callback=fn` answers JSONP. | ports | kept |
| Q11 | Validation errors are `400 {"error": "bad request", "detail": "..."}`, first failing field only, in a fixed order: from, to, container, depart. | `makeQuote` | kept |
| Q12 | Customer bookings are paged from 0. | `/customers/:id/bookings` | not ported yet |
