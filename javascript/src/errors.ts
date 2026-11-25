export type TransportErrorCode = "timeout" | "aborted" | "network_error" | "invalid_response";

/**
 * Base class for every error the SDK throws. `name` is the API's
 * Resend-compatible error name (for example `rate_limit_exceeded`), or a
 * transport code such as `network_error` when no API response was received.
 */
export class SoonerError extends Error {
  /** Same value as `name`, kept for compatibility. */
  readonly code: string;
  /** HTTP status, or `null` when no response was received. */
  readonly statusCode: number | null;
  /** Request ID from the response headers, when the API sent one. */
  readonly requestId: string | null;
  /** True when sending the same request again (with the same idempotency key) may succeed. */
  readonly retryable: boolean;
  /** Raw `Retry-After` header value, in seconds or as an HTTP date. */
  readonly retryAfter?: string;
  /**
   * The `Idempotency-Key` this call sent (yours, or the one the SDK generated), or `null`
   * when none was sent. Retry an uncertain send with this key and the same payload.
   */
  readonly idempotencyKey: string | null;

  constructor(
    message: string,
    details: {
      name: string;
      statusCode: number | null;
      requestId?: string | null;
      retryable: boolean;
      retryAfter?: string;
      idempotencyKey?: string | null;
    },
  ) {
    super(message);
    this.name = details.name;
    this.code = details.name;
    this.statusCode = details.statusCode;
    this.requestId = details.requestId ?? null;
    this.retryable = details.retryable;
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
    this.idempotencyKey = details.idempotencyKey ?? null;
  }

  /** Resend's error object shape: `{ name, message, statusCode }`. */
  toJSON(): { name: string; message: string; statusCode: number | null } {
    return { name: this.name, message: this.message, statusCode: this.statusCode };
  }
}

/** The API answered with a non-success HTTP status. */
export class SoonerApiError extends SoonerError {
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code: string,
    retryAfter?: string,
    extra: { requestId?: string | null; retryable?: boolean; idempotencyKey?: string | null } = {},
  ) {
    super(message, {
      name: code,
      statusCode: status,
      requestId: extra.requestId,
      retryable: extra.retryable ?? false,
      retryAfter,
      idempotencyKey: extra.idempotencyKey,
    });
    this.status = status;
  }
}

/** No usable API response: timeout, cancellation, network failure or an invalid body. */
export class SoonerTransportError extends SoonerError {
  declare readonly code: TransportErrorCode;

  constructor(
    message: string,
    code: TransportErrorCode,
    extra: { statusCode?: number | null; requestId?: string | null; idempotencyKey?: string | null } = {},
  ) {
    super(message, {
      name: code,
      statusCode: extra.statusCode ?? null,
      requestId: extra.requestId,
      retryable: code === "timeout" || code === "network_error",
      idempotencyKey: extra.idempotencyKey,
    });
  }
}

/** A webhook request failed signature, timestamp or payload checks. */
export class SoonerWebhookVerificationError extends SoonerError {
  constructor(message: string) {
    super(message, { name: "webhook_verification_failed", statusCode: null, retryable: false });
  }
}
