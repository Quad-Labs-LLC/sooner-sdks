import assert from "node:assert/strict";
import { test } from "node:test";
import { Sooner } from "../dist/index.js";
import { createInAppFeed } from "../dist/in-app.js";

test("publishing and session creation send project credentials only to their server endpoints", async () => {
  const calls = [];
  const client = new Sooner("sn_synthetic_test_key", {
    maxRetries: 0,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      assert.equal(options.headers.get("authorization"), "Bearer sn_synthetic_test_key");
      calls.push([path, options.headers.get("idempotency-key"), JSON.parse(options.body)]);
      return Response.json(path.endsWith("/sessions") ? { token: "test-token", expires_at: "2026-11-25T12:00:00Z" } : { id: "test-id" });
    },
  });

  const notification = { user_id: "alice", title: "Report ready" };
  assert.deepEqual(await client.inApp.publish(notification, { idempotencyKey: "report:alice" }), { id: "test-id" });
  assert.equal((await client.inApp.createSession("alice")).token, "test-token");
  assert.deepEqual(calls, [
    ["/in-app/notifications", "report:alice", notification],
    ["/in-app/sessions", null, { user_id: "alice" }],
  ]);
});

test("the browser renews a rejected session and reuses its replacement without cookies", async (t) => {
  const tokens = ["sn_feed." + "a".repeat(40), "sn_feed." + "b".repeat(40)];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([new URL(url).pathname, options.method, options.headers.authorization]);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    if (calls.length === 1) return new Response(null, { status: 401 });
    return Response.json(options.method === "GET" ? { data: [], unread_count: 0 } : { id: "notification" });
  });
  let issued = 0;
  const feed = createInAppFeed({
    getSession: async () => ({ token: tokens[issued++], expires_at: new Date(Date.now() + 60_000).toISOString() }),
  });

  assert.deepEqual(await feed.list(), { data: [], unread_count: 0 });
  assert.deepEqual(await feed.markRead("notification"), { id: "notification" });
  assert.equal(issued, 2);
  assert.deepEqual(calls, [
    ["/in-app/feed", "GET", "Bearer " + tokens[0]],
    ["/in-app/feed", "GET", "Bearer " + tokens[1]],
    ["/in-app/feed/notification/read", "POST", "Bearer " + tokens[1]],
  ]);
});
