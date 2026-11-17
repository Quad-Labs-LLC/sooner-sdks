---
name: sooner-webhooks
description: Implement or review a Sooner delivery webhook handler. Use when receiving delivery, bounce, complaint, or other email events, verifying signatures, or processing retries safely.
license: MIT
---

# Handle Sooner webhooks

1. Read [Sooner's signature contract](https://sooner.dev/docs/webhooks/verify-signatures) and the [event reference](https://sooner.dev/docs/webhooks/event-types). Keep each endpoint's `whsec_` signing secret in the server environment. Use a different secret in staging and production.
2. Capture the raw request body before JSON middleware changes it. Verify with an established Svix or Standard Webhooks library using the corresponding three signature headers and the signed attempt timestamp. Reject invalid or stale requests before parsing or triggering work.
3. Deduplicate using the verified event ID. Store it durably with the business update or durable enqueue so concurrent deliveries cannot execute the same effect twice. An attempt timestamp changes on retry. The event ID stays the same.
4. Persist the minimum delivery data needed by the application and acknowledge successful or already-processed events with a 2xx. Return a retryable failure if durable processing failed. Handle unknown event types without breaking valid events.
5. Test signed fixtures, altered raw bodies, expired timestamps, concurrent duplicates, and a failed first attempt. Use a test signing secret and a local receiver. Do not replay live events unless authorized.

Use bounce and complaint events to protect sending reputation. A delivered event indicates recipient-server acceptance. Opens and clicks can also come from automated clients.
