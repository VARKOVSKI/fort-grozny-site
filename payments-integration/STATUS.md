# YooKassa integration checkpoint — 25 November 2026

Status: **test adapter implemented; NOT deployed; no live payments enabled**.

- Existing identity/economy code was reviewed. The existing premium balance is `fgDonate`; ordinary coins must not be changed. Existing test trim checkout is separate from the public store.
- The new adapter supports `coins-1000` (99 RUB) and `coins-2500` (199 RUB), uses fixed server prices, requires the test key and test mode, creates bank card test payments, checks shop, amount, currency, payment ID, metadata and provider test status. No grant endpoint or client-side balance setter is introduced.
- `all-cars` stays disabled pending the exact approved inventory.
- Local Node test: PASS. Existing donation SQL and existing donation module on in-memory SQLite with a simulated provider also passed once-only trim issuance and unchanged balances. This is not a hosted end-to-end payment.
- Cloudflare dashboard access from this environment was blocked, and the existing Miniflare integration test could not reach its local loopback listener. No deployed Worker, existing database, Unity Cloud Code, or existing player balance was changed.
- Remaining integration: confirm hosted Identity/Cloud Code version and authenticated QA account binding; persist orders in isolated D1; wire provider adapter to the test Worker; use an authenticated internal fulfillment service with an atomic order receipt in the existing economy; verify one test payment end-to-end and retry behavior. Keep public store off and production credentials out of the repository.
- Run `node payments-integration/yookassa-test.test.mjs` from repository root to reproduce the adapter test.

No secrets are present in the added files; test fixtures are synthetic.
