# Sooner for JavaScript and TypeScript

Use the Sooner email API from Node.js 22 or later. Create an API key in the Sooner dashboard and keep it on your server.

```sh
pnpm add https://github.com/Quad-Labs-LLC/sooner-sdks/releases/download/v0.1.0/sooner-email-0.1.0.tgz
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

`SoonerApiError` exposes the HTTP `status`, API error `code`, and any `retryAfter` header. `SoonerTransportError` covers request cancellation, timeouts, connection errors, and invalid responses. The client makes one request per call. When retrying an uncertain send, reuse the original idempotency key and payload.

See the [Sooner SDK documentation](https://sooner.dev/docs/sdks/node) and [Emails API reference](https://sooner.dev/docs/api-reference/emails).
