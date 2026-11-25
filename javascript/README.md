# Sooner for JavaScript and TypeScript

Use the Sooner email API from Node.js 22 or later. Create an API key in the Sooner dashboard and keep it on your server.

```sh
pnpm add sooner-email@0.2.0
```

```ts
import { Sooner } from "sooner-email";

const sooner = new Sooner(process.env.SOONER_API_KEY);

const { id } = await sooner.emails.send({
  from: "Acme <orders@mail.yourcompany.com>",
  to: "ada@example.com",
  subject: "Order confirmed",
  text: "Thanks for your order.",
}, { idempotencyKey: "order-1042-confirmation" });
```

The client also supports `emails.sendBatch`, `emails.list`, `emails.get`, `emails.reschedule`, and `emails.cancel`. Listing, retrieval, rescheduling, and cancellation require a full-access key.

Use `sooner.inApp.publish` to send a notification to a user in your app and `sooner.inApp.createSession` to issue a short-lived feed token. Import `mountNotificationBell` or `createInAppFeed` from `sooner-email/in-app` in the browser. See the [in-app notification quickstart](https://sooner.dev/docs/in-app/quickstart).

Network errors, 429 and 5xx responses are retried twice by default (`maxRetries`) with exponential backoff and full jitter, honoring `Retry-After` up to 10 seconds. A longer `Retry-After` is not waited out: the error comes back at once with `retryable: true` and `retryAfter` set, so you choose when to try again. `totalTimeoutMs` (default 60000) caps the time one call spends across retries; `timeoutMs` (default 30000) is the deadline for each attempt. Sends and batches retry with your idempotency key or one generated per call, so a retry cannot send twice; cancel and reschedule retry only after a 429 or in-progress 409. Invalid arguments and options reject the returned promise.

Every error extends `SoonerError` with `name` (the API error name), `message`, `statusCode`, `requestId` (set when the API returned a request ID header), `retryable` and `idempotencyKey` (the key the call sent, including a generated one, or `null`). `SoonerApiError` (HTTP errors, also `status`, `code`, `retryAfter`) and `SoonerTransportError` (cancellation, timeouts, connection errors, invalid responses) are its subclasses. To retry an uncertain send yourself, send the same payload with `error.idempotencyKey`.

`await sooner.webhooks.verify(payload, headers, secret)` (or the standalone `verifyWebhook`) checks Svix-compatible signatures with Web Crypto and resolves to a typed event. Unlike Resend's synchronous `webhooks.verify`, it returns a promise: always `await` it. Without `await`, an invalid signature becomes a rejected promise instead of a thrown error, so a `try`/`catch` around the call does not stop your handler. The package has no runtime dependencies and no Node-only imports, so it runs on Node.js, Deno, Bun and edge runtimes.

See the [Sooner SDK documentation](https://sooner.dev/docs/sdks/node) and [Emails API reference](https://sooner.dev/docs/api-reference/emails).
