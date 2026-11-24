---
name: reference_payments_sandbox
description: "Payments sandbox: test cards, how to trigger 3-D Secure, where the gateway logs are"
metadata:
  type: reference
---

- Test card `4000 0000 0000 3220` always asks for 3-D Secure; `4000 0000 0000 0002` is always declined.
- Gateway logs: the `payments-gateway` index in the log viewer, filter by `order_id`.
- The sandbox resets every night at 03:00 UTC: orders created before that are gone.
