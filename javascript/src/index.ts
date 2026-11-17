const DEFAULT_ORIGIN = "https://api.sooner.dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const API_KEY = /^sn_[A-Za-z0-9_-]{16,200}$/;
const EMAIL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type AddressList = string | readonly string[];
export type EmailTag = { name: string; value: string };
export type EmailTemplate = { id: string; variables?: Record<string, string | number> };
export type EmailAttachment = {
  filename?: string;
  content_type?: string;
  content_id?: string;
} & ({ content: string | readonly number[]; path?: never } | { path: string; content?: never });

type EmailContent =
  | { template: EmailTemplate; from?: string; subject?: string; html?: string; text?: string }
  | ({ from: string; subject: string; template?: never } & (
      { html: string; text?: string } | { text: string; html?: string }
    ));

export type SendEmail = EmailContent & {
  to: AddressList;
  cc?: AddressList;
  bcc?: AddressList;
  reply_to?: AddressList;
  headers?: Record<string, string>;
  tags?: readonly EmailTag[];
  attachments?: readonly EmailAttachment[];
  scheduled_at?: string;
  topic_id?: string;
};

export type BatchEmail = EmailContent & Pick<SendEmail, "to" | "cc" | "bcc" | "reply_to" | "headers" | "tags" | "topic_id"> & {
  attachments?: never;
  scheduled_at?: never;
};

export interface EmailId {
  id: string;
}

export interface EmailMutation extends EmailId {
  object: "email";
}

export interface Email extends EmailMutation {
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  tags: EmailTag[];
  created_at: string;
  scheduled_at: string | null;
  status: string;
  last_event: string;
  error?: string;
}

export interface EmailPage {
  object: "list";
  data: Email[];
  has_more: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SendOptions extends RequestOptions {
  /** Reuse this key with the same payload if the request outcome is uncertain. */
  idempotencyKey?: string;
}

export interface ListOptions extends RequestOptions {
  limit?: number;
  after?: string;
}

export interface SoonerOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class SoonerApiError extends Error {
  override name = "SoonerApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

export class SoonerTransportError extends Error {
  override name = "SoonerTransportError";

  constructor(message: string, readonly code: "timeout" | "aborted" | "network_error" | "invalid_response") {
    super(message);
  }
}

function apiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new TypeError("baseUrl must be an HTTPS origin, or an HTTP loopback origin for local testing.");
  }
  return url.origin;
}

function emailPath(id: string): string {
  if (typeof id !== "string" || !EMAIL_ID.test(id)) {
    throw new TypeError("Expected a Sooner email ID without path separators.");
  }
  return `/emails/${id}`;
}

function responseObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasEmailId(value: unknown): boolean {
  const id = responseObject(value)?.id;
  return typeof id === "string" && EMAIL_ID.test(id);
}

function hasEmailObject(value: unknown): boolean {
  return hasEmailId(value) && responseObject(value)?.object === "email";
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    try {
      return responseObject(JSON.parse(body + decoder.decode()));
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Server-side client. Keep project API keys out of browser bundles. */
export class Sooner {
  readonly #origin: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(apiKey: string | undefined, options: SoonerOptions = {}) {
    if (typeof apiKey !== "string" || !API_KEY.test(apiKey)) {
      throw new TypeError("A Sooner API key starting with sn_ is required.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new RangeError("timeoutMs must be a positive integer in milliseconds.");
    }
    this.#origin = apiOrigin(options.baseUrl ?? DEFAULT_ORIGIN);
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  readonly emails = {
    send: (payload: SendEmail, options?: SendOptions) =>
      this.#request<EmailId>("POST", "/emails", hasEmailId, options, payload),

    sendBatch: (payload: readonly BatchEmail[], options?: SendOptions) =>
      this.#request<{ data: EmailId[] }>("POST", "/emails/batch", (data) =>
        Array.isArray(data.data) && data.data.length === payload.length && data.data.every(hasEmailId),
      options, payload),

    list: (options: ListOptions = {}) => {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.after !== undefined) query.set("after", options.after);
      return this.#request<EmailPage>("GET", query.size ? `/emails?${query}` : "/emails", (data) =>
        data.object === "list" && typeof data.has_more === "boolean" &&
        Array.isArray(data.data) && data.data.every(hasEmailObject),
      options);
    },

    get: (id: string, options?: RequestOptions) =>
      this.#request<Email>("GET", emailPath(id), hasEmailObject, options),

    reschedule: (id: string, scheduledAt: string, options?: RequestOptions) =>
      this.#request<EmailMutation>("PATCH", emailPath(id), hasEmailObject, options, { scheduled_at: scheduledAt }),

    cancel: (id: string, options?: RequestOptions) =>
      this.#request<EmailMutation>("POST", `${emailPath(id)}/cancel`, hasEmailObject, options),
  };

  async #request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    validate: (data: Record<string, unknown>) => boolean,
    options: SendOptions = {},
    payload?: unknown,
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
    });
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);

    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await this.#fetch(this.#origin + path, {
        method, headers, body, signal, redirect: "error", cache: "no-store",
      });
      const data = await readJsonObject(response);

      if (!response.ok) {
        const redact = (value: string) => value.replaceAll(this.#apiKey, "[redacted]");
        const retryAfter = response.headers.get("retry-after");
        throw new SoonerApiError(
          typeof data?.message === "string" ? redact(data.message) : `Sooner returned HTTP ${response.status}.`,
          response.status,
          typeof data?.name === "string" ? redact(data.name) : "unexpected_http_error",
          retryAfter === null ? undefined : redact(retryAfter),
        );
      }
      if (!data || !validate(data)) {
        throw new SoonerTransportError("Sooner returned an invalid or oversized response.", "invalid_response");
      }
      return data as T;
    } catch (error) {
      if (error instanceof SoonerApiError || error instanceof SoonerTransportError) throw error;
      if (options.signal?.aborted) throw new SoonerTransportError("The Sooner request was canceled.", "aborted");
      if (deadline.aborted) throw new SoonerTransportError("The Sooner request timed out.", "timeout");
      throw new SoonerTransportError("Could not complete the request to Sooner.", "network_error");
    }
  }
}
