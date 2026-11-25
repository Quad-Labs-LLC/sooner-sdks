import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { Sooner, SoonerWebhookVerificationError, Webhooks, verifyWebhook } from "../dist/index.js";

const secret = "whsec_" + Buffer.from("synthetic-webhook-signing-key!!").toString("base64");
const id = "msg_2c1f6f2b0a6c4f4f9d3b";
const now = 1_763_600_000;
const body = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-11-20T00:00:00.000Z",
  data: {
    email_id: "01jcz8w3f2x9k4m7n6p5q2r1s0",
    from: "sender@example.com",
    to: ["reader@example.com"],
    subject: "Hello",
    created_at: "2026-11-20T00:00:00.000Z",
    bounce: { type: "Permanent", subType: "General", message: "mailbox unavailable" },
  },
});

function sign(payload, timestamp = now, key = secret) {
  const raw = Buffer.from(key.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", raw).update(`${id}.${timestamp}.${payload}`).digest("base64");
}

function headers(payload = body, timestamp = now, signature = sign(payload, timestamp)) {
  return new Headers({ "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signature });
}

const at = { now: now * 1000 };

test("accepts a valid signature and returns the typed event", async () => {
  const event = await verifyWebhook(body, headers(), secret, at);
  assert.equal(event.type, "email.bounced");
  if (event.type === "email.bounced") assert.equal(event.data.bounce.type, "Permanent");
});

test("accepts bytes, plain header records, rotated signatures and Resend's argument shape", async () => {
  const record = { "Svix-Id": id, "svix-timestamp": [String(now)], "svix-signature": `v1,AAAA ${sign(body)}` };
  await verifyWebhook(new TextEncoder().encode(body), record, secret, at);
  const client = new Sooner("sn_synthetic_test_key");
  const event = await client.webhooks.verify({
    payload: body,
    headers: { id, timestamp: String(now), signature: sign(body) },
    webhookSecret: secret,
  }, at);
  assert.equal(event.type, "email.bounced");
  await new Webhooks().verify(body, headers(), secret, at);
});

test("rejects tampered payloads, wrong secrets and malformed signatures", async () => {
  const tampered = body.replace("Permanent", "Transient");
  const otherSecret = "whsec_" + Buffer.from("another-signing-key-of-32-bytes").toString("base64");
  const cases = [
    () => verifyWebhook(tampered, headers(body), secret, at),
    () => verifyWebhook(body, headers(), otherSecret, at),
    () => verifyWebhook(body, headers(body, now, "v1,not-base64!"), secret, at),
    () => verifyWebhook(body, headers(body, now, sign(body).replace("v1,", "v2,")), secret, at),
    () => verifyWebhook(body, new Headers({ "svix-id": id }), secret, at),
    () => verifyWebhook(JSON.parse(body), headers(), secret, at),
  ];
  for (const attempt of cases) {
    await assert.rejects(attempt(), error =>
      error instanceof SoonerWebhookVerificationError && error.name === "webhook_verification_failed" && error.retryable === false,
    );
  }
});

test("rejects expired and future timestamps outside the 5-minute tolerance", async () => {
  await assert.rejects(verifyWebhook(body, headers(body, now - 301), secret, at), /too old/);
  await assert.rejects(verifyWebhook(body, headers(body, now + 301), secret, at), /future/);
  await verifyWebhook(body, headers(body, now - 299), secret, at);
  await verifyWebhook(body, headers(body, now - 600), secret, { ...at, toleranceSeconds: 900 });
});
