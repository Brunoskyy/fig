# Index eval, 2026-10-01

44 questions (plain: business words only; code: names copied from the code) over 49 chunks of the legacy code. Model Xenova/bge-small-en-v1.5, RRF k = 60. Raw run: [runs/2026-10-01.json](runs/2026-10-01.json).

| mode | set | questions | recall@5 | MRR | hit@1 |
| --- | --- | --- | --- | --- | --- |
| keyword | plain | 32 | 0.344 | 0.276 | 0.219 |
| vector | plain | 32 | 0.703 | 0.628 | 0.563 |
| hybrid | plain | 32 | 0.719 | 0.454 | 0.313 |
| keyword | code | 12 | 1.000 | 0.875 | 0.750 |
| vector | code | 12 | 0.750 | 0.625 | 0.500 |
| hybrid | code | 12 | 0.917 | 0.833 | 0.750 |
| keyword | all | 44 | 0.523 | 0.439 | 0.364 |
| vector | all | 44 | 0.716 | 0.627 | 0.545 |
| hybrid | all | 44 | 0.773 | 0.558 | 0.432 |

Missed in the top 5:

- keyword: `heavy-box` (plain)
- keyword: `dangerous-minimum` (plain)
- keyword: `saturday-sailing` (plain)
- keyword: `loyalty-and-dangerous` (plain)
- keyword: `box-types` (plain)
- keyword: `health-check` (plain)
- keyword: `harbours-by-area` (plain)
- keyword: `validation-order` (plain)
- keyword: `weight-with-unit` (plain)
- keyword: `limit-before-account` (plain)
- keyword: `offer-validity` (plain)
- keyword: `plain-text-api` (plain)
- keyword: `double-reservation` (plain)
- keyword: `unknown-reservation` (plain)
- keyword: `after-sailing` (plain)
- keyword: `update-bunker` (plain)
- keyword: `unparseable-body` (plain)
- keyword: `body-size` (plain)
- keyword: `offer-columns` (plain)
- keyword: `premium-accounts` (plain)
- vector: `health-check` (plain)
- vector: `validation-order` (plain)
- vector: `weight-with-unit` (plain)
- vector: `limit-before-account` (plain)
- vector: `offer-validity` (plain)
- vector: `plain-text-api` (plain)
- vector: `stale-offer` (plain)
- vector: `premium-accounts` (plain)
- vector: `base-rates` (plain)
- vector: `code-overweight` (code)
- vector: `code-no-lane` (code)
- vector: `code-callback-regex` (code)
- hybrid: `health-check` (plain)
- hybrid: `validation-order` (plain)
- hybrid: `weight-with-unit` (plain)
- hybrid: `limit-before-account` (plain)
- hybrid: `offer-validity` (plain)
- hybrid: `plain-text-api` (plain)
- hybrid: `offer-columns` (plain)
- hybrid: `premium-accounts` (plain)
- hybrid: `base-rates` (plain)
- hybrid: `code-no-lane` (code)
