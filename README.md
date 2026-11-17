# Sooner SDKs and agent skills

Official clients for the [Sooner email API](https://sooner.dev/docs/api-reference/emails). Use them to send individual or batch emails, inspect delivery status, and manage scheduled messages. Keep your project key on the server.

| Language | Runtime | Registry | Guide |
| --- | --- | --- | --- |
| JavaScript and TypeScript | Node.js 22+ | [npm](https://www.npmjs.com/package/sooner-email) | [JavaScript SDK](javascript) |
| Python | Python 3.11+ | [PyPI](https://pypi.org/project/sooner-email/) | [Python SDK](python) |
| Go | Go 1.22+ | [Go Packages](https://pkg.go.dev/github.com/Quad-Labs-LLC/sooner-sdks/go) | [Go SDK](go) |
| Rust | Rust 1.88+ | [crates.io](https://crates.io/crates/sooner-email) | [Rust SDK](rust) |
| Ruby | Ruby 3.1+ | [RubyGems](https://rubygems.org/gems/sooner-email) | [Ruby SDK](ruby) |

Versioned packages and checksums are available from [GitHub Releases](https://github.com/Quad-Labs-LLC/sooner-sdks/releases). For examples and API permissions, see the [Sooner documentation](https://sooner.dev/docs).

## Coding-agent skills

Browse the [Sooner collection on skills.sh](https://skills.sh/quad-labs-llc/sooner-sdks).

```sh
pnpm dlx skills add Quad-Labs-LLC/sooner-sdks
```

- [sooner-send-email](skills/sooner-send-email) integrates transactional sends, batches, and idempotent retries.
- [sooner-webhooks](skills/sooner-webhooks) verifies signed delivery events and handles repeat deliveries.
- [sooner-mcp](skills/sooner-mcp) connects an assistant to Sooner with scoped access and user approval for changes.

## License

The SDKs and skills are available under the [MIT License](LICENSE).
