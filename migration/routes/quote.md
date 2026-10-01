# POST /api/v1/quote

Where the pricing lives. Every rule here changes money partners reconcile against, so the port reproduces the float arithmetic exactly, including the parts that look wrong.

## Legacy behaviour
- Body must be an object; arrays pass as an object with no fields (legacy/app.js:278).
- Validation order, first failure wins: from, to, container, known container, depart as a real `YYYY-MM-DD` (legacy/app.js:279-285). `2016-02-30` is accepted and rolls over to March 1 (legacy/app.js:93-100).
- Weight goes through `parseInt` (legacy/app.js:287-288).
- Overweight is checked before the customer and the lane, and answers `200 { ok: false, err: "OVERWEIGHT", max }` (legacy/app.js:289).
- Customer lookup when `customer` is present and not empty; unknown customer is `NO_CUSTOMER` (legacy/app.js:318-323).
- Lane lookup tries the direct lane, then the reverse one marked `reversed` (legacy/app.js:118-128); none is `NO_LANE` (legacy/app.js:298).
- Fuel percentage is the latest month on or before the departure month, else 0 (legacy/app.js:130-137).
- Price (legacy/app.js:153-193): base in dollars from cents, x1.05 if reversed (legacy/app.js:114-116); weight surcharge $150 per started 1,000 kg above 20,000; hazardous 18% of base, min $95; weekend $75 (legacy/app.js:148-151); peak 12% of base + weight (legacy/app.js:139-146); fuel on base; gold discount 7% of everything but hazardous; total rounded up to 5 cents; breakdown as `toFixed(2)` strings.
- The quote is stored with `created` now and `expires` 7 days later, and returned as `{ ok: true, quote }` (legacy/app.js:302-313, 199-215).
- Validation errors are `400 { error: "bad request", detail }`, malformed JSON is `400 ... "invalid JSON"`, from the error handler (legacy/app.js:327-333, 456-461).

## Quirks
- Q1 kept, Q2 kept, Q3 kept, Q4 kept, Q5 kept, Q6 kept, Q7 kept, Q8 kept, Q11 kept. Finance asked for no changes to totals during the migration.

## Parity cases
- existing: 32 cases in `parity/corpus/quote.yaml`, one or more per quirk.
- add: hazardous minimum of $95 on a cheap lane (Q4): no seeded lane reaches the minimum, so the corpus setup adds one.

## Target
Module service/src/quotes/: `pricing.ts` (pure, no Nest), `quote-request.ts` (validation), repository, service, controller. Mode after porting: service.

## Approval
