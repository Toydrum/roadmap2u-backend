import { ApiError, ApiErrorCode } from '@app/api/contracts';

/** HTTP envelope helpers — one place maps ApiError codes to statuses. */

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  USERNAME_TAKEN: 409,
  LAST_GUARDIAN: 409,
  CODE_INVALID: 400,
  CODE_EXPIRED: 410,
  LIMIT_EXCEEDED: 409,
  RATE_LIMITED: 429,
  SYNC_TOO_OLD: 426,
  // Client-minted transport codes never travel on the wire; if one somehow
  // reaches here it is a server bug.
  offline: 500,
  server: 500,
  unknown: 500,
};

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function ok(payload: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: payload === undefined ? '' : JSON.stringify(payload),
  };
}

export function errorResponse(error: unknown): HttpResponse {
  if (error instanceof ApiError) {
    return {
      statusCode: STATUS[error.code] ?? 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: { code: error.code, message: error.message } }),
    };
  }
  console.error('unhandled', error);
  return {
    statusCode: 500,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: { code: 'server', message: 'internal error' } }),
  };
}

export function parseJsonBody<T>(body: string | undefined): T {
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError('VALIDATION', 'body is not valid JSON');
  }
}
