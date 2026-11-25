import { SoonerWebhookVerificationError } from "./errors.js";

/** Default allowed clock difference between Sooner and your server, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// ── Event payloads ──────────────────────────────────────────────────────────

/** Fields every `email.*` event carries for a sent email. */
export interface EmailEventData {
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  /** Tags sent with the email, as `{ name: value }`. */
  tags?: Record<string, string>;
  broadcast_id?: string;
  template_id?: string;
  /** Set on events produced by test-mode sends. */
  test?: boolean;
}

export interface EmailBouncedData extends EmailEventData {
  bounce: { type: string; subType: string; message?: string };
}
export interface EmailComplainedData extends EmailEventData {
  complaint: { type?: string };
}
export interface EmailOpenedData extends EmailEventData {
  open: { ipAddress?: string; userAgent?: string };
}
export interface EmailClickedData extends EmailEventData {
  click: { link: string; ipAddress?: string; userAgent?: string };
}
export interface EmailDeliveryDelayedData extends EmailEventData {
  delay: { type?: string };
}
export interface EmailFailedData extends EmailEventData {
  failed?: { reason?: string };
  reason?: string;
}
export interface EmailSuppressedData extends EmailEventData {
  suppressed: { message: string; type: "OnAccountSuppressionList" | "UnsubscribedFromTopic" | (string & {}) };
}

export interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
}

export interface EmailReceivedData {
  email_id: string;
  created_at: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  received_for: string[];
  message_id: string | null;
  subject: string;
  attachments: ReceivedAttachment[];
}

export interface ContactEventData {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
  created_at: string;
}

export interface DomainEventData {
  id: string;
  name: string;
  status: string;
}

type Event<T extends string, D> = { type: T; created_at: string; data: D };

/** Every webhook event Sooner sends. Narrow on `type` to get the typed `data`. */
export type WebhookEvent =
  | Event<"email.sent" | "email.delivered" | "email.scheduled" | "email.canceled", EmailEventData>
  | Event<"email.delivery_delayed", EmailDeliveryDelayedData>
  | Event<"email.bounced", EmailBouncedData>
  | Event<"email.complained", EmailComplainedData>
  | Event<"email.opened", EmailOpenedData>
  | Event<"email.clicked", EmailClickedData>
  | Event<"email.failed", EmailFailedData>
  | Event<"email.suppressed", EmailSuppressedData>
  | Event<"email.received", EmailReceivedData>
  | Event<"contact.created" | "contact.updated" | "contact.deleted", ContactEventData>
  | Event<"domain.verified" | "domain.failed", DomainEventData>;

export type WebhookEventType = WebhookEvent["type"];

// ── Verification ────────────────────────────────────────────────────────────

type HeaderValue = string | readonly string[] | null | undefined;
/** A Fetch `Headers` object, a Node-style header record, or Resend's `{ id, timestamp, signature }`. */
export type WebhookHeaders =
  | { get(name: string): string | null }
  | Record<string, HeaderValue>;

export interface VerifyWebhookOptions {
  /** Allowed clock difference in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Override the current time, for tests. */
  now?: Date | number;
}

/** Resend SDK's argument shape for `webhooks.verify`. */
export interface ResendStyleVerifyInput {
  payload: string | Uint8Array | ArrayBuffer;
  headers: WebhookHeaders;
  webhookSecret: string;
}

const encoder = new TextEncoder();

function header(headers: WebhookHeaders, names: readonly string[]): string | null {
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    for (const name of names) {
      const value = (headers as { get(name: string): string | null }).get(name);
      if (value) return value;
    }
    return null;
  }
  const record = headers as Record<string, HeaderValue>;
  for (const name of names) {
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() !== name) continue;
      const value = record[key];
      const first = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
      if (first) return first;
    }
  }
  return null;
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function payloadBytes(payload: unknown): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw new SoonerWebhookVerificationError(
    "Pass the raw request body as a string or bytes. A parsed and re-serialized body cannot be verified.",
  );
}

/**
 * Verify a Sooner webhook (Svix-compatible headers, HMAC-SHA256, `whsec_` secret)
 * and return the typed event. Throws `SoonerWebhookVerificationError` when the
 * signature, timestamp or payload is invalid. Uses Web Crypto only, so it runs on
 * Node.js, Deno, Bun, Cloudflare Workers and other edge runtimes.
 */
export async function verifyWebhook(
  payload: string | Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const body = payloadBytes(payload);
  if (!headers || typeof headers !== "object") throw new SoonerWebhookVerificationError("Missing webhook headers.");
  const id = header(headers, ["svix-id", "webhook-id", "id"]);
  const timestamp = header(headers, ["svix-timestamp", "webhook-timestamp", "timestamp"]);
  const signatures = header(headers, ["svix-signature", "webhook-signature", "signature"]);
  if (!id || !timestamp || !signatures) {
    throw new SoonerWebhookVerificationError("Missing svix-id, svix-timestamp or svix-signature header.");
  }
  if (!/^\d{1,15}$/.test(timestamp)) throw new SoonerWebhookVerificationError("Invalid webhook timestamp.");
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor(
    (options.now === undefined ? Date.now() : typeof options.now === "number" ? options.now : options.now.getTime()) / 1000,
  );
  const sentAt = Number(timestamp);
  if (nowSeconds - sentAt > tolerance) throw new SoonerWebhookVerificationError("Webhook timestamp is too old.");
  if (sentAt - nowSeconds > tolerance) throw new SoonerWebhookVerificationError("Webhook timestamp is in the future.");

  if (typeof secret !== "string" || !secret) throw new SoonerWebhookVerificationError("A webhook signing secret is required.");
  const keyBytes = base64Bytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!keyBytes || keyBytes.length === 0) throw new SoonerWebhookVerificationError("The webhook signing secret is not valid base64.");
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);

  let valid = false;
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const candidate = base64Bytes(value);
    // subtle.verify compares in constant time.
    if (candidate && candidate.length === 32 && await crypto.subtle.verify("HMAC", key, candidate as BufferSource, signed)) {
      valid = true;
    }
  }
  if (!valid) throw new SoonerWebhookVerificationError("No matching webhook signature.");

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SoonerWebhookVerificationError("Webhook payload is not valid JSON.");
  }
  const record = event as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || typeof record.type !== "string" ||
      !record.data || typeof record.data !== "object") {
    throw new SoonerWebhookVerificationError("Webhook payload is not a Sooner event.");
  }
  return event as WebhookEvent;
}

/** `sooner.webhooks`: accepts `(payload, headers, secret)` or Resend's `({ payload, headers, webhookSecret })`. */
export class Webhooks {
  verify(input: ResendStyleVerifyInput, options?: VerifyWebhookOptions): Promise<WebhookEvent>;
  verify(
    payload: string | Uint8Array | ArrayBuffer,
    headers: WebhookHeaders,
    secret: string,
    options?: VerifyWebhookOptions,
  ): Promise<WebhookEvent>;
  verify(
    first: string | Uint8Array | ArrayBuffer | ResendStyleVerifyInput,
    second?: WebhookHeaders | VerifyWebhookOptions,
    secret?: string,
    options?: VerifyWebhookOptions,
  ): Promise<WebhookEvent> {
    if (typeof first === "object" && first !== null && !(first instanceof Uint8Array) &&
        !(first instanceof ArrayBuffer) && "webhookSecret" in first) {
      return verifyWebhook(first.payload, first.headers, first.webhookSecret, second as VerifyWebhookOptions | undefined);
    }
    return verifyWebhook(first as string | Uint8Array | ArrayBuffer, second as WebhookHeaders, secret as string, options);
  }
}
