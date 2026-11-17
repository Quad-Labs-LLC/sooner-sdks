# Sooner Go SDK

Typed email sending and lifecycle operations for Go 1.22 and later. Uses the Go standard library.

Install the versioned Go module.

```sh
go get github.com/Quad-Labs-LLC/sooner-sdks/go@v0.1.0
```

```go
package main

import (
    "context"
    "log"
    "os"

    sooner "github.com/Quad-Labs-LLC/sooner-sdks/go"
)

func main() {
    client, err := sooner.New(os.Getenv("SOONER_API_KEY"), sooner.Options{})
    if err != nil {
        log.Fatal(err)
    }
    email, err := client.Emails.Send(context.Background(), sooner.SendEmail{
        From: "Acme <hello@mail.example.com>",
        To: []string{"ada@example.com"},
        Subject: "Welcome",
        Text: "Welcome to Acme.",
    }, sooner.SendOptions{IdempotencyKey: "welcome-user-123"})
    if err != nil {
        log.Fatal(err)
    }
    log.Print(email.ID)
}
```

The client supports these methods.

- `Emails.Send(ctx, email, options)`
- `Emails.SendBatch(ctx, emails, options)`
- `Emails.List(ctx, ListOptions{Limit: 100, After: "email-id"})`
- `Emails.Get(ctx, "email-id")`
- `Emails.Reschedule(ctx, "email-id", "2026-12-01T09:00:00Z")`
- `Emails.Cancel(ctx, "email-id")`

The sending domain must be verified. Sending-only keys can send single and batch messages. Reading, canceling and rescheduling require full access. Batch sends allow 1–100 messages and reject attachments and scheduling.

Successful methods return typed API data. HTTP failures return `*sooner.APIError`, accessible through `errors.As`, with `StatusCode`, `Code`, `Message` and the raw `RetryAfter` header. Request failures return a redacted `*sooner.TransportError`. Its `Is` method preserves error matching, so `errors.Is(err, context.DeadlineExceeded)` works. A request failure can leave a send outcome unknown. Reuse the original idempotency key and exact payload if retrying that send.

The default origin is `https://api.sooner.dev`. Configure `Options.BaseURL` for staging or a loopback HTTP test server. Custom origins must use HTTPS, except for localhost and loopback IPs. Redirects are rejected so the project key stays with the configured origin. Each request has a 30-second deadline unless `Options.Timeout` overrides it. A shorter caller context wins. The client makes a single attempt per method call.

Run the offline loopback tests with `go test ./...`.

Source and releases are available at https://github.com/Quad-Labs-LLC/sooner-sdks. Licensed under MIT.
