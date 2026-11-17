# Sooner Rust SDK

Typed asynchronous client for the Sooner email API. Requires Rust 1.88 or newer and an async runtime such as Tokio. The SDK uses HTTPS with Rustls and has no native TLS dependency.

Install from crates.io:

```sh
cargo add sooner-email@0.1.0
```

Add an async runtime to your application:

```toml
[dependencies]
sooner-email = "0.1.0"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

```rust,no_run
use sooner_email::{SendEmail, Sooner};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sooner = Sooner::new(std::env::var("SOONER_API_KEY")?)?;
    let email = SendEmail {
        to: Some("Ada <ada@example.com>".into()),
        from: Some("Acme <hello@mail.example.com>".into()),
        subject: Some("Welcome".into()),
        text: Some("Thanks for joining.".into()),
        ..Default::default()
    };
    let accepted = sooner.emails().send(&email, Some("welcome-user-1042")).await?;
    println!("Accepted {}", accepted.id);
    Ok(())
}
```

`sooner.emails()` exposes `send`, `send_batch`, `list`, `get`, `reschedule`, and `cancel`. `send` and `send_batch` accept an optional idempotency key. Sending requires a verified sender domain and a project key with sending access. Reading, rescheduling, and cancellation need full access. Batch payloads cannot contain attachments or scheduled sends. Field names follow the API's snake_case spelling. Attachments accept base64 content or a remote URL. Render React templates to HTML before sending.

```rust,no_run
# use sooner_email::{Sooner, ListOptions};
# async fn example(sooner: Sooner) -> Result<(), sooner_email::SoonerError> {
let page = sooner.emails().list(&ListOptions {
    limit: Some(25),
    after: None,
}).await?;
for email in page.data {
    println!("{} {}", email.id, email.status);
}
sooner.emails().reschedule("email_id", "in 1 hour").await?;
sooner.emails().cancel("email_id").await?;
# Ok(())
# }
```

Errors expose `status`, `code`, `message`, and the raw `retry_after` header. Network errors use `network_error`; deadlines use `request_timeout`. A timeout or lost connection can happen after the server accepted a send. Retry using the same idempotency key and payload to preserve request ownership. The client sends each request once. It rejects redirects and does not forward the bearer token to their destinations.

`Sooner::with_options(api_key, base_url, timeout)` configures a private API endpoint or staging. The base URL must be an HTTPS origin, or an HTTP loopback origin for local tests, without credentials, path, query or fragment. Requests have a 30-second default deadline and responses are bounded to 2 MiB. Dropping the request future cancels local waiting; server acceptance may still have occurred.

Tests use local synthetic HTTP responses, including redirect, API error, query encoding, and request-body contracts. They send no email.

```sh
cargo test --manifest-path packages/sdk-rust/Cargo.toml
cargo package --manifest-path packages/sdk-rust/Cargo.toml --allow-dirty --no-verify
```

Published under the MIT license. Source and issue tracker: https://github.com/Quad-Labs-LLC/sooner-sdks.
