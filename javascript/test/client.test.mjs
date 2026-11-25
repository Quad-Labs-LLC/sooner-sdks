import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Sooner, SoonerApiError, SoonerError, SoonerTransportError } from "../dist/index.js";

const apiKey = "sn_synthetic_test_key";
const emailId = "01jcz8w3f2x9k4m7n6p5q2r1s0";
const message = { from: "sender@example.com", to: ["reader@example.com"], subject: "Welcome", text: "Hello" };

test("uses the public API contract for send, batch, reads, reschedule and cancel", async () => {
  const calls = [];
  const client = new Sooner(apiKey, {
    maxRetries: 0,
    fetch: async (url, options) => {
      calls.push({
        method: options.method,
        path: new URL(url).pathname + new URL(url).search,
        body: options.body ? JSON.parse(options.body) : undefined,
        key: options.headers.get("idempotency-key"),
      });
      assert.equal(new URL(url).origin, "https://api.sooner.dev");
      assert.equal(options.headers.get("authorization"), `Bearer ${apiKey}`);
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      const { pathname, search } = new URL(url);
      const email = { id: emailId, object: "email" };
      if (pathname === "/emails/batch") return Response.json({ data: [{ id: emailId }] });
      if (pathname === "/emails" && search) return Response.json({ object: "list", data: [email], has_more: false });
      if (pathname === "/emails") return Response.json({ id: emailId });
      return Response.json(email);
    },
  });

  assert.deepEqual(await client.emails.send(message, { idempotencyKey: "welcome-1" }), { id: emailId });
  await client.emails.sendBatch([message], { idempotencyKey: "batch-1" });
  await client.emails.list({ limit: 5, after: emailId });
  await client.emails.get(emailId);
  await client.emails.reschedule(emailId, "in 1 hour");
  await client.emails.cancel(emailId);

  assert.deepEqual(calls, [
    { method: "POST", path: "/emails", body: message, key: "welcome-1" },
    { method: "POST", path: "/emails/batch", body: [message], key: "batch-1" },
    { method: "GET", path: `/emails?limit=5&after=${emailId}`, body: undefined, key: null },
    { method: "GET", path: `/emails/${emailId}`, body: undefined, key: null },
    { method: "PATCH", path: `/emails/${emailId}`, body: { scheduled_at: "in 1 hour" }, key: null },
    { method: "POST", path: `/emails/${emailId}/cancel`, body: undefined, key: null },
  ]);
});

test("reports a quota error with Retry-After and does not retry when retries are off", async () => {
  let calls = 0;
  const client = new Sooner(apiKey, {
    maxRetries: 0,
    fetch: async (_url, options) => {
      calls++;
      assert.equal(options.headers.get("idempotency-key"), null);
      return Response.json({ name: "rate_limit_exceeded", message: "Try later" }, {
        status: 429,
        headers: { "Retry-After": "2" },
      });
    },
  });
  await assert.rejects(client.emails.send(message), error =>
    error instanceof SoonerApiError && error instanceof SoonerError && error.status === 429 &&
    error.statusCode === 429 && error.code === "rate_limit_exceeded" && error.name === "rate_limit_exceeded" &&
    error.retryAfter === "2" && error.retryable === true,
  );
  assert.equal(calls, 1);
});

test("keeps the API key on the configured origin and applies a request deadline", async t => {
  let receivedRedirect = false;
  const server = createServer((request, response) => {
    if (request.url === "/emails") {
      response.writeHead(307, { Location: "/redirected" }).end();
    } else if (request.url === "/redirected") {
      receivedRedirect = true;
      response.end("{}");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(new Sooner(apiKey, { baseUrl, maxRetries: 0 }).emails.send(message), { code: "network_error" });
  assert.equal(receivedRedirect, false);
  await assert.rejects(new Sooner(apiKey, { baseUrl, timeoutMs: 25, maxRetries: 0 }).emails.get(emailId), { code: "timeout" });
});

test("rejects invalid IDs and unexpected success bodies", async () => {
  assert.throws(() => new Sooner(apiKey, { baseUrl: "http://example.com" }), TypeError);
  const client = new Sooner(apiKey, { fetch: async () => new Response("<html>") });
  await assert.rejects(client.emails.get("../emails"), TypeError);
  await assert.rejects(client.emails.list(), error =>
    error instanceof SoonerTransportError && error.code === "invalid_response",
  );
  const wrongShape = new Sooner(apiKey, { fetch: async () => Response.json({ ok: true }) });
  await assert.rejects(wrongShape.emails.send(message), { code: "invalid_response" });
});

test("caps response bodies and redacts credentials from error details", async () => {
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  const client = new Sooner(apiKey, { fetch: async () => new Response(oversized) });
  await assert.rejects(client.emails.send(message), { code: "invalid_response" });
  const throttled = new Sooner(apiKey, {
    maxRetries: 0,
    fetch: async () => new Response(oversized, { status: 429, headers: { "Retry-After": "5" } }),
  });
  await assert.rejects(throttled.emails.send(message), { status: 429, retryAfter: "5" });
  const echo = new Sooner(apiKey, {
    fetch: async () => Response.json({ name: apiKey, message: `Rejected ${apiKey}` }, { status: 403 }),
  });
  await assert.rejects(echo.emails.send(message), { status: 403, code: "[redacted]", message: "Rejected [redacted]" });
});
