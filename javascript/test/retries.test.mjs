import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Sooner, SoonerApiError, SoonerTransportError, parseRetryAfter } from "../dist/index.js";

const apiKey = "sn_synthetic_test_key";
const emailId = "01jcz8w3f2x9k4m7n6p5q2r1s0";
const message = { from: "sender@example.com", to: ["reader@example.com"], subject: "Welcome", text: "Hello" };
const fast = { initialRetryDelayMs: 1, maxRetryDelayMs: 2 };

function scripted(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, key: options.headers.get("idempotency-key") });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  };
  return { calls, fetch };
}

const status = (code, body, headers = {}) => () => Response.json(body, { status: code, headers });
const ok = (body) => () => Response.json(body);

test("retries 429 after Retry-After over a real HTTP server and reuses the idempotency key", async t => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ at: Date.now(), key: request.headers["idempotency-key"] });
    if (seen.length === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ name: "rate_limit_exceeded", message: "Slow down" }));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: emailId }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const client = new Sooner(apiKey, { baseUrl: `http://127.0.0.1:${server.address().port}`, ...fast });
  assert.deepEqual(await client.emails.send(message), { id: emailId });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].at - seen[0].at >= 950, "waited for Retry-After");
  assert.match(seen[0].key, /^sooner-sdk-[0-9a-f-]{36}$/);
  assert.equal(seen[1].key, seen[0].key);
});

test("retries 5xx and network failures for sends with a caller key, keeping the key", async () => {
  const { calls, fetch } = scripted([
    status(500, { name: "internal_server_error", message: "Boom" }),
    new TypeError("fetch failed"),
    ok({ id: emailId }),
  ]);
  const client = new Sooner(apiKey, { fetch, ...fast });
  assert.deepEqual(await client.emails.send(message, { idempotencyKey: "order-7" }), { id: emailId });
  assert.deepEqual(calls.map(call => call.key), ["order-7", "order-7", "order-7"]);
});

test("batch sends get one generated key reused across retries", async () => {
  const { calls, fetch } = scripted([status(503, { name: "internal_server_error", message: "Busy" }), ok({ data: [{ id: emailId }] })]);
  const client = new Sooner(apiKey, { fetch, ...fast });
  await client.emails.sendBatch([message]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].key);
  assert.equal(calls[1].key, calls[0].key);
  await client.emails.sendBatch([message]).catch(() => {});
  assert.notEqual(calls[2].key, calls[0].key, "each call gets its own key");
});

test("does not retry 4xx validation errors or quota exhaustion", async () => {
  for (const [code, name] of [[422, "validation_error"], [403, "invalid_api_key"], [429, "daily_quota_exceeded"], [409, "invalid_idempotent_request"]]) {
    const { calls, fetch } = scripted([status(code, { name, message: "No" }, { "retry-after": "1" })]);
    const client = new Sooner(apiKey, { fetch, ...fast });
    await assert.rejects(client.emails.send(message), error =>
      error instanceof SoonerApiError && error.name === name && error.statusCode === code && error.retryable === false,
    );
    assert.equal(calls.length, 1, name);
  }
});

test("stops after maxRetries and reports the last error as retryable", async () => {
  const { calls, fetch } = scripted([status(502, { name: "internal_server_error", message: "Bad gateway" })]);
  const client = new Sooner(apiKey, { fetch, maxRetries: 3, ...fast });
  await assert.rejects(client.emails.get(emailId), { name: "internal_server_error", statusCode: 502, retryable: true });
  assert.equal(calls.length, 4);
  const perCall = scripted([status(502, { name: "internal_server_error", message: "Bad gateway" })]);
  await assert.rejects(new Sooner(apiKey, { fetch: perCall.fetch, ...fast }).emails.get(emailId, { maxRetries: 0 }));
  assert.equal(perCall.calls.length, 1);
});

test("never replays a cancel or reschedule after an uncertain outcome, but retries a refused one", async () => {
  for (const failure of [status(500, { name: "internal_server_error", message: "Boom" }), new TypeError("fetch failed")]) {
    const { calls, fetch } = scripted([failure, ok({ id: emailId, object: "email" })]);
    await assert.rejects(new Sooner(apiKey, { fetch, ...fast }).emails.cancel(emailId));
    assert.equal(calls.length, 1);
  }
  const { calls, fetch } = scripted([
    status(429, { name: "rate_limit_exceeded", message: "Slow" }, { "retry-after": "0" }),
    ok({ id: emailId, object: "email" }),
  ]);
  await new Sooner(apiKey, { fetch, ...fast }).emails.reschedule(emailId, "in 1 hour");
  assert.equal(calls.length, 2);
});

test("returns a long Retry-After to the caller instead of waiting", async () => {
  const { calls, fetch } = scripted([status(429, { name: "rate_limit_exceeded", message: "Slow" }, { "retry-after": "3600" })]);
  const started = Date.now();
  await assert.rejects(new Sooner(apiKey, { fetch, ...fast }).emails.get(emailId), { retryAfter: "3600", retryable: true });
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1000);
});

test("an abort during backoff stops retrying", async () => {
  const controller = new AbortController();
  const { calls, fetch } = scripted([status(503, { name: "internal_server_error", message: "Busy" })]);
  const client = new Sooner(apiKey, { fetch, initialRetryDelayMs: 10_000, maxRetryDelayMs: 10_000 });
  const pending = client.emails.get(emailId, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => error instanceof SoonerTransportError && error.code === "aborted");
  assert.equal(calls.length, 1);
});

test("falls back when the runtime rejects RequestInit.cache", async () => {
  const seen = [];
  const client = new Sooner(apiKey, {
    fetch: async (_url, options) => {
      seen.push(options.cache);
      if (options.cache) throw new TypeError("The 'cache' field on 'RequestInitializerDict' is not implemented.");
      return Response.json({ id: emailId, object: "email" });
    },
  });
  await client.emails.get(emailId);
  await client.emails.get(emailId);
  assert.deepEqual(seen, ["no-store", undefined, undefined]);
});

test("parses Retry-After seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0.5"), 500);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(parseRetryAfter(null), null);
});

test("errors serialize to Resend's error shape and validate retry options", () => {
  const error = new SoonerApiError("Slow down", 429, "rate_limit_exceeded", "1", { requestId: "req_1", retryable: true });
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { name: "rate_limit_exceeded", message: "Slow down", statusCode: 429 });
  assert.equal(error.requestId, "req_1");
  assert.throws(() => new Sooner(apiKey, { maxRetries: -1 }), RangeError);
  assert.throws(() => new Sooner(apiKey, { maxRetries: 1.5 }), RangeError);
});

test("errors expose the idempotency key the call sent, generated or not", async () => {
  const generated = scripted([status(503, { name: "internal_server_error", message: "Busy" })]);
  await assert.rejects(new Sooner(apiKey, { fetch: generated.fetch, ...fast }).emails.send(message), error => {
    assert.match(error.idempotencyKey, /^sooner-sdk-[0-9a-f-]{36}$/);
    assert.equal(error.idempotencyKey, generated.calls[0].key);
    return error.retryable === true;
  });
  assert.equal(generated.calls.length, 3);
  const network = scripted([new TypeError("fetch failed")]);
  await assert.rejects(
    new Sooner(apiKey, { fetch: network.fetch, ...fast }).emails.send(message, { idempotencyKey: "order-9" }),
    error => error instanceof SoonerTransportError && error.idempotencyKey === "order-9",
  );
  const none = scripted([status(500, { name: "internal_server_error", message: "Boom" })]);
  await assert.rejects(new Sooner(apiKey, { fetch: none.fetch, ...fast }).emails.cancel(emailId), { idempotencyKey: null });
});

test("a Retry-After above 10 seconds is returned at once as retryable", async () => {
  const { calls, fetch } = scripted([status(429, { name: "rate_limit_exceeded", message: "Slow" }, { "retry-after": "11" })]);
  const started = Date.now();
  await assert.rejects(new Sooner(apiKey, { fetch, ...fast }).emails.send(message), error =>
    error.retryable === true && error.retryAfter === "11" && typeof error.idempotencyKey === "string",
  );
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1000);
});

test("totalTimeoutMs bounds a call across retries", async () => {
  const { calls, fetch } = scripted([status(503, { name: "internal_server_error", message: "Busy" })]);
  const client = new Sooner(apiKey, { fetch, maxRetries: 10, initialRetryDelayMs: 60, maxRetryDelayMs: 60, totalTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(client.emails.get(emailId), { statusCode: 503, retryable: true });
  assert.ok(Date.now() - started < 500, "stopped at the overall deadline");
  assert.ok(calls.length < 11);
  assert.throws(() => new Sooner(apiKey, { totalTimeoutMs: 0 }), RangeError);
});

test("invalid per-call options reject the promise instead of throwing", async () => {
  const client = new Sooner(apiKey, { fetch: async () => Response.json({ id: emailId }) });
  let pending;
  assert.doesNotThrow(() => { pending = client.emails.send(message, { maxRetries: -1 }); });
  await assert.rejects(pending, RangeError);
  await assert.rejects(client.emails.sendBatch([message], { maxRetries: 11 }), RangeError);
  await assert.rejects(client.emails.list({ maxRetries: 1.5 }), RangeError);
});
