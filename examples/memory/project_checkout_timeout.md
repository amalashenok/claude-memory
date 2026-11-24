---
name: project_checkout_timeout
description: "ACME-412 checkout times out when the payment provider answers slower than 10 s; retry with idempotency key"
metadata:
  type: project
  status: active
  title: ACME-412 checkout timeout on slow payment provider
  next: "2026-11-20: retry with idempotency key implemented on branch ACME-412-checkout-retry, tests green; next: load test in staging, then PR"
  modified: 2026-11-20T15:30:00.000Z
---

**2026-11-18.** Checkout calls the payment provider with a 10 s timeout and gives up; the provider then
completes the payment anyway, so the user sees an error and gets charged. Logs: 37 cases last week.

**2026-11-20.** Fix: retry once with the same idempotency key before failing; the provider deduplicates.
Rejected: raising the timeout to 30 s — it keeps the request thread busy and hides the problem.
