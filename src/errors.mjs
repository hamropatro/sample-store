/** An error that already knows which HTTP status the customer should see. */
export class HttpError extends Error {
  constructor(status, message, { code, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export const badRequest = (message, options) => new HttpError(400, message, options);
export const unauthorized = (message, options) => new HttpError(401, message, options);
export const forbidden = (message, options) => new HttpError(403, message, options);
export const notFound = (message = 'Not found.', options) => new HttpError(404, message, options);
export const conflict = (message, options) => new HttpError(409, message, options);
export const unsupportedMedia = (message, options) => new HttpError(415, message, options);
export const payloadTooLarge = (message, options) => new HttpError(413, message, options);
export const tooManyRequests = (message, options) => new HttpError(429, message, options);
export const badGateway = (message, options) => new HttpError(502, message, options);

/**
 * A call to Hamro Pay did not produce a usable answer. `status` is the upstream HTTP
 * status when there was one, so callers can tell a configuration problem (401/403)
 * apart from an outage or a network reset.
 */
export class GatewayError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
  /** True when Hamro Pay refused the credentials rather than failing to answer. */
  get isAuthFailure() { return this.status === 401 || this.status === 403; }
}
