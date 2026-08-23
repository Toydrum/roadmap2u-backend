import { describe, expect, it } from 'vitest';
import { isTrustedRequestId } from '../lambda/request-id';

describe('trusted AWS request ids', () => {
  it.each([
    'request-1',
    'CiVhEg0EoAMEVwg=',
    'base64/padded==',
    'x'.repeat(128),
  ])('accepts %s', (requestId) => {
    expect(isTrustedRequestId(requestId)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '=padding-first',
    'padding=inside',
    'too-much-padding===',
    'request#separator',
    'x'.repeat(129),
  ])('rejects %s', (requestId) => {
    expect(isTrustedRequestId(requestId)).toBe(false);
  });
});
