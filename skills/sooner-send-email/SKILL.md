---
name: sooner-send-email
description: Integrate the Sooner email API in a server application. Use when implementing transactional sends, batches, scheduling, idempotent retries, or delivery status lookups with Sooner.
license: MIT
---

# Send email with Sooner

1. Identify the server runtime and use the matching first-party package from the [Sooner SDK repository](https://github.com/Quad-Labs-LLC/sooner-sdks). Read its install instructions for the required runtime and release version. Prefer the application's current package manager.
2. Store `SOONER_API_KEY` in the server environment. For sends, use a Sooner project key with sending access and a sender on a domain verified in that project. Listing, retrieval, rescheduling, and cancellation require full access.
3. Send `to` with `from`, `subject`, and at least one of `text` or `html`, or use a published template. Look up [payload fields and limits](https://sooner.dev/docs/api-reference/emails) before using attachments, scheduling, or batches.
4. Derive a stable idempotency key from the business event, such as `order-1042-confirmation`. Store or reconstruct the exact payload. After a timeout or lost response, retry that payload with the same key. Follow [Sooner's idempotency window and retry rules](https://sooner.dev/docs/getting-started/idempotency).
5. Record the returned email ID and treat it as acceptance. Use status or delivery events to distinguish queued, sent, delivered, bounced, and suppressed messages.

Test with a mocked HTTP response or an explicitly configured staging project. Assert the payload, idempotency header, and behavior when the request outcome is uncertain. Before a live send, confirm the project, sender, recipients, and content with the user.

For direct HTTP, use `https://api.sooner.dev` and bearer authentication. Keep API keys, message bodies, and recipient addresses out of client bundles and routine logs.
