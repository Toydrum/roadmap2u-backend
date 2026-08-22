import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_CODE_VERSION,
  DEFAULT_GRANT_DURATION_SECONDS,
  DEFAULT_REDEEM_WINDOW_SECONDS,
  accessCodeKey,
  accessCodeCommandKey,
  accessCodeAttemptKey,
  buildIssuedAccessCode,
  buildSponsoredGrant,
  computeAccessCodeMac,
  generateAccessCode,
  parseAccessCode,
  publicAccessCodeMetadata,
  resolveAccessCodeTerms,
  verifyAccessCodeMac,
} from '../lambda/commercial/access-codes';

const NOW = Date.parse('2026-08-22T18:00:00.000Z');
const ISSUANCE_ID = '7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a';
const HMAC_KEY = Buffer.alloc(32, 0x5a);

describe('sponsored access-code primitives', () => {
  it('generates a versioned code with 256 random bits and parses the secret as non-enumerable memory', () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, 0xa5));

    const generated = generateAccessCode({ issuanceId: ISSUANCE_ID, randomBytes: random });

    expect(random).toHaveBeenCalledWith(32);
    expect(generated.plaintext).toMatch(/^RM2U1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const parsed = parseAccessCode(generated.plaintext);
    expect(parsed).toMatchObject({ version: ACCESS_CODE_VERSION, issuanceId: ISSUANCE_ID });
    expect(parsed?.secret).toEqual(Buffer.alloc(32, 0xa5));
    expect(JSON.stringify(parsed)).not.toContain('a5');
    expect(Object.keys(parsed ?? {})).not.toContain('secret');
  });

  it.each([
    '',
    'RM2U0.7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a.AAAAAAAAAAAAAAAAAAAAAA',
    'RM2U1.not-a-uuid.AAAAAAAAAAAAAAAAAAAAAA',
    'RM2U1.7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a.too-short',
    'RM2U1.7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a.AAAAAAAAAAAAAAAAAAAAAA.extra',
    `RM2U1.${ISSUANCE_ID}.${'A'.repeat(260)}`,
    `RM2U1.${ISSUANCE_ID}.AAAAAAAAAAAAAAAAAAAAAé`,
    ` RM2U1.${ISSUANCE_ID}.AAAAAAAAAAAAAAAAAAAAAA`,
  ])('rejects malformed, weak, non-ASCII or oversized input before lookup: %s', (code) => {
    expect(parseAccessCode(code)).toBeNull();
  });

  it('stores a versioned HMAC and verifies it without accepting a different secret or key', () => {
    const generated = generateAccessCode({
      issuanceId: ISSUANCE_ID,
      randomBytes: () => Buffer.alloc(32, 0x31),
    });
    const parsed = parseAccessCode(generated.plaintext)!;
    const mac = computeAccessCodeMac(parsed, HMAC_KEY);

    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyAccessCodeMac(parsed, mac, HMAC_KEY)).toBe(true);
    expect(
      verifyAccessCodeMac(
        parseAccessCode(`RM2U1.${ISSUANCE_ID}.${Buffer.alloc(32, 0x32).toString('base64url')}`)!,
        mac,
        HMAC_KEY,
      ),
    ).toBe(false);
    expect(verifyAccessCodeMac(parsed, mac, Buffer.alloc(32, 0x59))).toBe(false);
    expect(verifyAccessCodeMac(parsed, 'not-a-mac', HMAC_KEY)).toBe(false);
  });

  it('normalizes temporary defaults and enforces duration and redemption bounds', () => {
    expect(resolveAccessCodeTerms({})).toEqual({
      mode: 'temporary',
      durationSeconds: DEFAULT_GRANT_DURATION_SECONDS,
      redeemWindowSeconds: DEFAULT_REDEEM_WINDOW_SECONDS,
    });
    expect(
      resolveAccessCodeTerms({
        durationSeconds: 24 * 60 * 60,
        redeemWindowSeconds: 60 * 60,
      }),
    ).toEqual({
      mode: 'temporary',
      durationSeconds: 24 * 60 * 60,
      redeemWindowSeconds: 60 * 60,
    });
    expect(() => resolveAccessCodeTerms({ durationSeconds: 24 * 60 * 60 - 1 })).toThrow(
      'invalid access-code terms',
    );
    expect(() => resolveAccessCodeTerms({ redeemWindowSeconds: 30 * 24 * 60 * 60 + 1 })).toThrow(
      'invalid access-code terms',
    );
  });

  it('requires explicit permanent mode and records no automatic grant expiration', () => {
    expect(resolveAccessCodeTerms({ permanent: true, confirmPermanent: true })).toEqual({
      mode: 'permanent',
      durationSeconds: null,
      redeemWindowSeconds: DEFAULT_REDEEM_WINDOW_SECONDS,
    });
    expect(() => resolveAccessCodeTerms({ permanent: true })).toThrow(
      'permanent access requires confirmation',
    );
    expect(() =>
      resolveAccessCodeTerms({ permanent: true, confirmPermanent: true, durationSeconds: 10 }),
    ).toThrow('invalid access-code terms');
  });

  it('builds a server-normalized CODE item without plaintext, target or reservation', () => {
    const secret = Buffer.alloc(32, 0x44);
    const plaintext = `${ACCESS_CODE_VERSION}.${ISSUANCE_ID}.${secret.toString('base64url')}`;
    const parsed = parseAccessCode(plaintext)!;
    const item = buildIssuedAccessCode({
      issuanceId: ISSUANCE_ID,
      secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
      secretKeyVersion: 'v1',
      issuedAt: NOW,
      issuedBy: 'arn:aws:sts::123456789012:assumed-role/operator/session',
      reason: 'beta cohort 1',
      terms: resolveAccessCodeTerms({}),
    });

    expect(item).toMatchObject({
      ...accessCodeKey(ISSUANCE_ID),
      issuanceId: ISSUANCE_ID,
      status: 'issued',
      grantOfferKey: 'premium_demo',
      planKey: 'premium',
      grantMode: 'temporary',
      durationSeconds: DEFAULT_GRANT_DURATION_SECONDS,
      redeemBy: NOW + DEFAULT_REDEEM_WINDOW_SECONDS * 1_000,
    });
    expect(item.limits).toEqual({ maxActiveTrees: null, maxVisibleBranchesPerTree: null });
    expect(item.capabilities).toEqual({ cloudSync: true, social: true, family: false });
    const stored = JSON.stringify(item);
    expect(stored).not.toContain(plaintext);
    expect(stored).not.toContain(secret.toString('base64url'));
    expect(item).not.toHaveProperty('plaintext');
    expect(item).not.toHaveProperty('secret');
    expect(item).not.toHaveProperty('targetSub');
    expect(item).not.toHaveProperty('reservation');
  });

  it('starts a deterministic sponsored grant at redemption time', () => {
    const parsed = parseAccessCode(
      `${ACCESS_CODE_VERSION}.${ISSUANCE_ID}.${Buffer.alloc(32, 0x45).toString('base64url')}`,
    )!;
    const code = buildIssuedAccessCode({
      issuanceId: ISSUANCE_ID,
      secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
      secretKeyVersion: 'v1',
      issuedAt: NOW,
      issuedBy: 'operator',
      reason: 'beta',
      terms: resolveAccessCodeTerms({ durationSeconds: 2 * 24 * 60 * 60 }),
    });
    const redeemedAt = NOW + 60_000;

    const grant = buildSponsoredGrant(code, 'sub-adult', redeemedAt);

    expect(grant).toMatchObject({
      pk: 'USER#sub-adult',
      sk: `GRANT#code-${ISSUANCE_ID}`,
      ownerSub: 'sub-adult',
      grantId: `code-${ISSUANCE_ID}`,
      sourceKind: 'sponsored',
      startsAt: redeemedAt,
      expiresAt: redeemedAt + 2 * 24 * 60 * 60 * 1_000,
      status: 'active',
    });
  });

  it('builds bounded keys and returns metadata that omits secrets and redeemer identity', () => {
    expect(accessCodeKey(ISSUANCE_ID)).toEqual({
      pk: `ACCESS_CODE#${ISSUANCE_ID}`,
      sk: 'CODE',
    });
    expect(accessCodeCommandKey('e3850eda-32e1-4b2b-a1bf-233226881128')).toEqual({
      pk: 'ADMIN#SPONSORED',
      sk: 'COMMAND#e3850eda-32e1-4b2b-a1bf-233226881128',
    });
    expect(accessCodeAttemptKey('sub-adult', NOW)).toEqual({
      pk: 'ACCESS_CODE_ATTEMPT#sub-adult',
      sk: 'HOUR#2026-08-22T18',
    });

    const parsed = parseAccessCode(
      `${ACCESS_CODE_VERSION}.${ISSUANCE_ID}.${Buffer.alloc(32, 0x46).toString('base64url')}`,
    )!;
    const code = {
      ...buildIssuedAccessCode({
        issuanceId: ISSUANCE_ID,
        secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
        secretKeyVersion: 'v1',
        issuedAt: NOW,
        issuedBy: 'operator',
        reason: 'beta',
        terms: resolveAccessCodeTerms({}),
      }),
      status: 'redeemed' as const,
      redeemerSub: 'sub-private',
      redeemedAt: NOW + 1,
    };
    const metadata = publicAccessCodeMetadata(code);
    const json = JSON.stringify(metadata);
    expect(json).not.toContain(code.secretMac);
    expect(json).not.toContain('sub-private');
    expect(metadata).toMatchObject({ issuanceId: ISSUANCE_ID, status: 'redeemed' });
  });
});
