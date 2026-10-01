# Migration plan

Quayside 1.9.3, surveyed with `/fig:survey`. Legacy is one file, `legacy/app.js`, 473 lines, 11 routes. The service is `service/` (NestJS). Both use the same SQLite database during the migration; the edge (`edge/routes.yaml`) decides who answers.

| route | lines | rules | quirks | state | order |
| --- | --- | --- | --- | --- | --- |
| GET /api/v1/ports | legacy/app.js:253-271 | region filter (uppercased), order by name, JSONP | Q10 | service | 1 |
| POST /api/v1/quote | legacy/app.js:277-333 | validation order, weight parse, overweight, customer, lane lookup with reverse, fuel month, pricing | Q1-Q8, Q11 | service | 2 |
| GET /api/v1/bookings/:id | legacy/app.js:382-390 | lookup, booking JSON shape | Q9 (fixed) | shadow | 3 |
| GET /ping | legacy/app.js:245-247 | plain-text version | | legacy | 4 |
| GET /api/v1/quote/:id | legacy/app.js:345-351 | lookup, quote JSON shape | Q9 | legacy | 5 |
| GET /api/v1/customers/:id/bookings | legacy/app.js:392-403 | paging, 10 per page, newest first | Q12 | legacy | 6 |
| POST /api/v1/bookings | legacy/app.js:357-380 | quote required, expiry, one live booking per quote | | legacy | 7 |
| POST /api/v1/bookings/:id/cancel | legacy/app.js:405-432 | fee by days before departure, no cancel after departure | | legacy | 8 |
| POST /quote | legacy/app.js:335-343 | v0 text format over the quote rules | Q11 | legacy | 9 |
| GET /admin/fuel | legacy/app.js:438-443 | full fuel table | | legacy | 10 |
| POST /admin/fuel | legacy/app.js:445-454 | month and pct validation, upsert | | legacy | 11 |
| JSON body parser | legacy/app.js:238 | 200 kB limit | | shared | |
| error handler | legacy/app.js:456-461 | invalid JSON 400, everything else 500 text | Q11 | shared | |
| request log | legacy/app.js:240-243 | one line per request | | replaced | |

Shared pieces are reproduced in `service/src/common/` (`legacy-errors.ts`, `logger.ts`) rather than ported per route. The request log is replaced by structured JSON lines with a request id.

## Order

Read-only routes with no rules first (ports, the golden route), then the route that holds most of the rules (quote), then a lookup with a deliberate fix (bookings by id) to prove shadow mode. Writes come last: shadow mode cannot cover them, because sending a write to both systems would write twice to the shared database, so they need a complete corpus before they flip.

## Open questions

- **Q12, zero-based paging.** The mobile app pages from 1 and adds its own offset. Keep or fix needs an answer from the mobile team before `/customers/:id/bookings` is planned.
- **v0 text endpoint.** Two partners still post to `POST /quote`. Port it as a thin formatter over the quote service, or retire it with the partners. Undecided.
- **Admin fuel.** No authentication in legacy (it sat behind the office VPN). The service must not expose it without auth, which makes it an intentional difference by definition.
