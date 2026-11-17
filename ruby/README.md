# Sooner Ruby SDK

Ruby 3.1 or later. Uses standard and bundled `net/http`, `json`, `uri`, `ipaddr` and `timeout`. Verified locally with Ruby 4.0.

Install from RubyGems:

```sh
gem install sooner-email --version 0.1.0
```

```ruby
require "sooner_email"

client = SoonerEmail::Client.new(ENV.fetch("SOONER_API_KEY"))
email = client.emails.send({
  from: "Acme <hello@mail.example.com>",
  to: ["ada@example.com"],
  subject: "Welcome",
  text: "Welcome to Acme."
}, idempotency_key: "welcome-user-123")

puts email.fetch("id")
```

The client supports these email methods.

- `emails.send(payload, idempotency_key: nil)`
- `emails.send_batch(payloads, idempotency_key: nil)`
- `emails.list(limit: nil, after: nil)`
- `emails.get(id)`
- `emails.reschedule(id, scheduled_at: "2026-12-01T09:00:00Z")`
- `emails.cancel(id)`

Payload hashes use the API's snake_case field names with symbol or string keys. Calls return parsed response hashes with string keys. Batch sends accept 1–100 messages and reject attachments or scheduling. Sending-only keys can send email. Reading, canceling and rescheduling require full access. The sending domain must be verified.

HTTP failures raise `SoonerEmail::APIError` with `status`, `code`, `message` and the raw `retry_after` header. Network failures and timeouts raise `SoonerEmail::TransportError` with a stable `code` of `network_error`, `timeout_error` or `invalid_response`. Transport exception text is redacted. Request failure can leave a send outcome unknown. Reuse the exact payload and original idempotency key when retrying that send.

The constructor accepts `base_url:` and `timeout:`. The default origin is `https://api.sooner.dev`. The default total request deadline is 30 seconds. Custom origins require HTTPS, except localhost or loopback HTTP origins for development. Redirects are rejected. Each call makes a single attempt.

Run offline tests with `ruby -Ilib test/client_test.rb`. Build from this directory using `gem build sooner-email.gemspec --output /tmp/sooner-email-0.1.0.gem`.

Source and releases are available at https://github.com/Quad-Labs-LLC/sooner-sdks/tree/main/ruby. Licensed under MIT.
