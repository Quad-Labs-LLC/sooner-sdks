import { SoonerApiError, SoonerError, SoonerTransportError } from "./errors.js";
import { Webhooks } from "./webhooks.js";

export { SoonerApiError, SoonerError, SoonerTransportError, SoonerWebhookVerificationError } from "./errors.js";
export type { TransportErrorCode } from "./errors.js";
export * from "./webhooks.js";

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
  /** Override the client's `maxRetries` for this call. */
  maxRetries?: number;
}

export interface SendOptions extends RequestOptions {
  /**
   * Reuse this key with the same payload if the request outcome is uncertain.
   * When retries are enabled and no key is given, the SDK generates one per call
   * so its own retries can never send the email twice.
   */
  idempotencyKey?: string;
}

export interface ListOptions extends RequestOptions {
  limit?: number;
  after?: string;
}

export interface SoonerOptions {
  baseUrl?: string;
  /** Deadline for each attempt, in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Overall budget for one call across retries, in milliseconds. Default 60000.
   * No retry starts once it would end past this budget, and retried attempts are
   * cut short to fit it. The first attempt always gets the full `timeoutMs`.
   */
  totalTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Retries after the first attempt for network errors, 429 and 5xx. Default 2. Set 0 to disable. */
  maxRetries?: number;
  /** First backoff ceiling in milliseconds. Default 500. Backoff doubles with full jitter. */
  initialRetryDelayMs?: number;
  /** Largest backoff in milliseconds. Default 8000. */
  maxRetryDelayMs?: number;
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

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
/**
 * A longer Retry-After is returned to the caller instead of waited out: the error
 * keeps `retryable` and exposes `retryAfter`, so the caller decides when to retry.
 */
export const MAX_RETRY_AFTER_MS = 10_000;
/** 429 names that do not clear within a retry window. */
const QUOTA_ERRORS = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

type Method = "GET" | "POST" | "PATCH";

/** Whether an HTTP failure is transient. */
function transientStatus(status: number, name: string): boolean {
  if (status === 429) return !QUOTA_ERRORS.has(name);
  if (status === 409) return name === "concurrent_idempotent_requests";
  return status === 408 || status >= 500;
}

/** 429 and in-progress 409 responses are refused before any work, so any method may repeat them. */
function refusedBeforeWork(status: number): boolean {
  return status === 429 || status === 409;
}

/** Retry-After as milliseconds, from delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function nonNegativeInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer between 0 and ${max}.`);
  }
  return value;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Runtimes without RequestInit.cache support (older Cloudflare Workers compatibility
// dates) reject the option while building the request, before anything is sent.
let cacheOptionSupported = true;

/** Server-side client. Keep project API keys out of browser bundles. */
export class Sooner {
  readonly #origin: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxRetries: number;
  readonly #initialRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;

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
    const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 2_147_483_647) {
      throw new RangeError("totalTimeoutMs must be a positive integer in milliseconds.");
    }
    this.#totalTimeoutMs = totalTimeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, "maxRetries", 10);
    this.#initialRetryDelayMs = nonNegativeInteger(options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS, "initialRetryDelayMs", 60_000);
    this.#maxRetryDelayMs = nonNegativeInteger(options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS, "maxRetryDelayMs", 300_000);
  }

  /** Verify signed webhook requests. Works without network access. */
  readonly webhooks = new Webhooks();

  /** Publish app notifications and issue short-lived feed credentials from your server. */
  readonly inApp = {
    publish: async (
      notification: { user_id: string; title: string; body?: string; href?: string },
      options: RequestOptions & { idempotencyKey: string },
    ): Promise<{ id: string }> =>
      this.#request("POST", "/in-app/notifications", (data) => typeof data.id === "string", options, notification),

    createSession: async (userId: string, options?: RequestOptions): Promise<{ token: string; expires_at: string }> =>
      this.#request("POST", "/in-app/sessions", (data) =>
        typeof data.token === "string" && typeof data.expires_at === "string", options, { user_id: userId }),
  };

  readonly emails = {
    // Methods are async so invalid arguments reject the returned promise instead of throwing.
    send: async (payload: SendEmail, options?: SendOptions): Promise<EmailId> =>
      this.#request<EmailId>("POST", "/emails", hasEmailId, this.#withIdempotency(options), payload),

    sendBatch: async (payload: readonly BatchEmail[], options?: SendOptions): Promise<{ data: EmailId[] }> =>
      this.#request<{ data: EmailId[] }>("POST", "/emails/batch", (data) =>
        Array.isArray(data.data) && data.data.length === payload.length && data.data.every(hasEmailId),
      this.#withIdempotency(options), payload),

    list: async (options: ListOptions = {}): Promise<EmailPage> => {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.after !== undefined) query.set("after", options.after);
      return this.#request<EmailPage>("GET", query.size ? `/emails?${query}` : "/emails", (data) =>
        data.object === "list" && typeof data.has_more === "boolean" &&
        Array.isArray(data.data) && data.data.every(hasEmailObject),
      options);
    },

    get: async (id: string, options?: RequestOptions): Promise<Email> =>
      this.#request<Email>("GET", emailPath(id), hasEmailObject, options),

    reschedule: async (id: string, scheduledAt: string, options?: RequestOptions): Promise<EmailMutation> =>
      this.#request<EmailMutation>("PATCH", emailPath(id), hasEmailObject, options, { scheduled_at: scheduledAt }),

    cancel: async (id: string, options?: RequestOptions): Promise<EmailMutation> =>
      this.#request<EmailMutation>("POST", `${emailPath(id)}/cancel`, hasEmailObject, options),
  };

  #retries(options: RequestOptions = {}): number {
    return options.maxRetries === undefined ? this.#maxRetries : nonNegativeInteger(options.maxRetries, "maxRetries", 10);
  }

  /** Sends get a generated key when retries are on, so a retry can only replay the original result. */
  #withIdempotency(options: SendOptions = {}): SendOptions {
    if (options.idempotencyKey !== undefined || this.#retries(options) === 0) return options;
    return { ...options, idempotencyKey: `sooner-sdk-${crypto.randomUUID()}` };
  }

  #backoff(retry: number): number {
    const ceiling = Math.min(this.#maxRetryDelayMs, this.#initialRetryDelayMs * 2 ** retry);
    return Math.floor(Math.random() * ceiling);
  }

  async #request<T>(
    method: Method,
    path: string,
    validate: (data: Record<string, unknown>) => boolean,
    options: SendOptions = {},
    payload?: unknown,
  ): Promise<T> {
    const maxRetries = this.#retries(options);
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    // Without a key, a POST or PATCH that may have reached the API is never repeated.
    const replaySafe = method === "GET" || options.idempotencyKey !== undefined;
    const deadlineAt = Date.now() + this.#totalTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      let error: SoonerError;
      try {
        const timeoutMs = attempt === 0 ? this.#timeoutMs : Math.max(1, Math.min(this.#timeoutMs, deadlineAt - Date.now()));
        return await this.#attempt<T>(method, path, validate, options, body, timeoutMs);
      } catch (caught) {
        error = caught as SoonerError;
      }
      if (attempt >= maxRetries || !error.retryable) throw error;
      let delay: number;
      if (error instanceof SoonerApiError) {
        if (!replaySafe && !refusedBeforeWork(error.status)) throw error;
        const retryAfter = parseRetryAfter(error.retryAfter);
        if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) throw error;
        delay = retryAfter ?? this.#backoff(attempt);
      } else {
        if (!replaySafe) throw error;
        delay = this.#backoff(attempt);
      }
      // Leave room for the retry itself; otherwise hand the last error back now.
      if (Date.now() + delay >= deadlineAt) throw error;
      try {
        await sleep(delay, options.signal);
      } catch {
        throw new SoonerTransportError("The Sooner request was canceled.", "aborted", {
          idempotencyKey: options.idempotencyKey ?? null,
        });
      }
    }
  }

  async #attempt<T>(
    method: Method,
    path: string,
    validate: (data: Record<string, unknown>) => boolean,
    options: SendOptions,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);

    const idempotencyKey = options.idempotencyKey ?? null;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const init: RequestInit = { method, headers, body, signal, redirect: "error" };
      let response: Response;
      if (cacheOptionSupported) {
        try {
          response = await this.#fetch(this.#origin + path, { ...init, cache: "no-store" });
        } catch (error) {
          if (!(error instanceof TypeError && /\bcache\b/i.test(error.message))) throw error;
          cacheOptionSupported = false;
          response = await this.#fetch(this.#origin + path, init);
        }
      } else {
        response = await this.#fetch(this.#origin + path, init);
      }
      const data = await readJsonObject(response);
      const redact = (value: string) => value.replaceAll(this.#apiKey, "[redacted]");
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");

      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const name = typeof data?.name === "string" ? redact(data.name) : "unexpected_http_error";
        throw new SoonerApiError(
          typeof data?.message === "string" ? redact(data.message) : `Sooner returned HTTP ${response.status}.`,
          response.status,
          name,
          retryAfter === null ? undefined : redact(retryAfter),
          {
            requestId: requestId === null ? null : redact(requestId),
            retryable: transientStatus(response.status, name),
            idempotencyKey,
          },
        );
      }
      if (!data || !validate(data)) {
        throw new SoonerTransportError("Sooner returned an invalid or oversized response.", "invalid_response", {
          statusCode: response.status,
          requestId: requestId === null ? null : redact(requestId),
          idempotencyKey,
        });
      }
      return data as T;
    } catch (error) {
      if (error instanceof SoonerError) throw error;
      const extra = { idempotencyKey };
      if (options.signal?.aborted) throw new SoonerTransportError("The Sooner request was canceled.", "aborted", extra);
      if (deadline.aborted) throw new SoonerTransportError("The Sooner request timed out.", "timeout", extra);
      throw new SoonerTransportError("Could not complete the request to Sooner.", "network_error", extra);
    }
  }
}
