const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*={0,2}$/;

/** Accepts bounded AWS request ids, including terminal base64 padding. */
export function isTrustedRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    REQUEST_ID_PATTERN.test(value)
  );
}
