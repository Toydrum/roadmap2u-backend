import { ApiError } from '@app/api/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import {
  ACCESS_CODE_VERSION,
  buildIssuedAccessCode,
  buildSponsoredGrant,
  computeAccessCodeMac,
  parseAccessCode,
  resolveAccessCodeTerms,
  type AccessCodeItem,
} from '../lambda/commercial/access-codes';
import {
  AccessCodeRedeemer,
  type AccessCodeRedemptionDeps,
  type RedemptionAccountSnapshot,
  type RedemptionCommitProposal,
} from '../lambda/commercial/access-code-redemption';
import type { CommercialConfigResult, CommercialFlags } from '../lambda/commercial/flags';
import type { AccessItem, GrantItem } from '../lambda/commercial/model';
import type { ProfileItem } from '../lambda/db';

const NOW = Date.parse('2026-08-22T18:30:00.000Z');
const OWNER = 'sub-adult';
const OTHER = 'sub-other';
const ISSUANCE_ID = '7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a';
const REQUEST_ID = 'request-123';
const HMAC_KEY = Buffer.alloc(32, 0x5a);
const SECRET = Buffer.alloc(32, 0x31);
const PLAINTEXT = `${ACCESS_CODE_VERSION}.${ISSUANCE_ID}.${SECRET.toString('base64url')}`;

function flags(overrides: Partial<CommercialFlags> = {}): CommercialConfigResult {
  return {
    status: 'available',
    freshness: 'fresh',
    loadedAt: NOW,
    flags: {
      revision: 1,
      quotaMode: 'enforce',
      capabilityMode: 'enforce',
      accessCodeIssuanceEnabled: true,
      accessCodeRedemptionEnabled: true,
      premiumPaymentsEnabled: false,
      updatedAt: NOW,
      updatedBy: 'operator',
      reason: 'test',
      ...overrides,
    },
  };
}

function code(overrides: Partial<AccessCodeItem> = {}): AccessCodeItem {
  const parsed = parseAccessCode(PLAINTEXT)!;
  return {
    ...buildIssuedAccessCode({
      issuanceId: ISSUANCE_ID,
      secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
      secretKeyVersion: 'v1',
      issuedAt: NOW - 60_000,
      issuedBy: 'operator',
      reason: 'beta',
      terms: resolveAccessCodeTerms({}),
    }),
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileItem> = {}): ProfileItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'PROFILE',
    userId: OWNER,
    username: 'adult',
    displayName: 'Adult',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 100_000,
    status: 'active',
    email: 'adult@example.com',
    ...overrides,
  };
}

function freeAccess(ownerSub = OWNER): AccessItem {
  return deriveAccessItem(ownerSub, NOW - 1_000, undefined, []);
}

function account(overrides: Partial<RedemptionAccountSnapshot> = {}): RedemptionAccountSnapshot {
  return {
    profile: profile(),
    access: freeAccess(),
    grants: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AccessCodeRedemptionDeps> = {}) {
  const proposals: RedemptionCommitProposal[] = [];
  const deps: AccessCodeRedemptionDeps = {
    now: () => NOW,
    resolveFlags: vi.fn(async () => flags()),
    consumeAttempt: vi.fn(async () => ({ allowed: true as const })),
    readCode: vi.fn(async () => code()),
    readSecretKey: vi.fn(async () => HMAC_KEY),
    readAccountSnapshot: vi.fn(async () => account()),
    commitRedemption: vi.fn(async (proposal) => {
      proposals.push(proposal);
      return 'committed' as const;
    }),
    emitMetric: vi.fn(),
    ...overrides,
  };
  return { deps, proposals, redeemer: new AccessCodeRedeemer(deps) };
}

async function redeem(
  redeemer: AccessCodeRedeemer,
  overrides: Partial<Parameters<AccessCodeRedeemer['redeem']>[0]> = {},
) {
  return redeemer.redeem({
    ownerSub: OWNER,
    emailVerified: true,
    code: PLAINTEXT,
    requestId: REQUEST_ID,
    ...overrides,
  });
}

function expectApiError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describe('AccessCodeRedeemer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts the padded request ids emitted by API Gateway', async () => {
    const { proposals, redeemer } = makeDeps();

    await redeem(redeemer, { requestId: 'CiVhEg0EoAMEVwg=' });

    expect(proposals[0]).toMatchObject({
      requestId: 'CiVhEg0EoAMEVwg=',
      audit: { requestId: 'CiVhEg0EoAMEVwg=' },
    });
  });

  it('rejects malformed input before flags, rate limits or any code lookup', async () => {
    const { deps, redeemer } = makeDeps();

    await expect(redeem(redeemer, { code: `RM2U1.${ISSUANCE_ID}.short` })).rejects.toSatisfy(
      (error: unknown) => {
        expectApiError(error, 'ACCESS_CODE_INVALID');
        return true;
      },
    );

    expect(deps.resolveFlags).not.toHaveBeenCalled();
    expect(deps.consumeAttempt).not.toHaveBeenCalled();
    expect(deps.readCode).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'unavailable', reason: 'missing' } satisfies CommercialConfigResult],
    [flags({ accessCodeRedemptionEnabled: false })],
  ])('fails closed when commercial configuration cannot authorize redemption', async (result) => {
    const { deps, redeemer } = makeDeps({ resolveFlags: vi.fn(async () => result) });

    await expect(redeem(redeemer)).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'COMMERCIAL_CONFIGURATION_UNAVAILABLE');
      return true;
    });
    expect(deps.consumeAttempt).not.toHaveBeenCalled();
  });

  it('consumes the account-hour attempt before reading or validating the code and limits attempt six', async () => {
    const order: string[] = [];
    const { deps, redeemer } = makeDeps({
      consumeAttempt: vi.fn(async () => {
        order.push('attempt');
        return { allowed: false as const, retryAfterSeconds: 1_800 };
      }),
      readCode: vi.fn(async () => {
        order.push('code');
        return code();
      }),
    });

    await expect(redeem(redeemer)).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'ACCESS_CODE_RATE_LIMITED');
      return true;
    });
    expect(order).toEqual(['attempt']);
    expect(deps.emitMetric).toHaveBeenCalledWith('rate_limited');
  });

  it.each([
    ['missing', undefined],
    ['wrong HMAC', code({ secretMac: Buffer.alloc(32, 0x66).toString('base64url') })],
    ['expired', code({ redeemBy: NOW })],
    ['revoked', code({ status: 'revoked', revokedAt: NOW - 1 })],
    [
      'redeemed by another account',
      code({ status: 'redeemed', redeemerSub: OTHER, redeemedAt: NOW - 1 }),
    ],
  ])('uses the same invalid-code error for %s', async (_label, stored) => {
    const { deps, redeemer } = makeDeps({ readCode: vi.fn(async () => stored) });

    await expect(redeem(redeemer)).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'ACCESS_CODE_INVALID');
      expect((error as Error).message).toBe('ACCESS_CODE_INVALID');
      return true;
    });
    expect(deps.emitMetric).toHaveBeenCalledWith('invalid');
  });

  it.each([
    ['unverified token', false, account()],
    ['minor account', true, account({ profile: profile({ accountType: 'minor' }) })],
  ])(
    'rejects an ineligible %s without consuming the code',
    async (_label, emailVerified, snapshot) => {
      const { deps, redeemer } = makeDeps({ readAccountSnapshot: vi.fn(async () => snapshot) });

      await expect(redeem(redeemer, { emailVerified })).rejects.toSatisfy((error: unknown) => {
        expectApiError(error, 'FORBIDDEN');
        return true;
      });
      expect(deps.commitRedemption).not.toHaveBeenCalled();
    },
  );

  it('rejects a closing account and preserves the code', async () => {
    const { deps, redeemer } = makeDeps({
      readAccountSnapshot: vi.fn(async () =>
        account({ closure: { pk: `ACCOUNT_CLOSURE#${OWNER}` } }),
      ),
    });

    await expect(redeem(redeemer)).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'CONFLICT');
      return true;
    });
    expect(deps.commitRedemption).not.toHaveBeenCalled();
  });

  it('atomically proposes CODE, deterministic GRANT, refreshed ACCESS and sanitized audit', async () => {
    const { proposals, redeemer } = makeDeps();

    const access = await redeem(redeemer);

    expect(access).toMatchObject({ effectivePlanKey: 'premium', revision: 2 });
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal).toMatchObject({
      ownerSub: OWNER,
      issuanceId: ISSUANCE_ID,
      expectedCodeRevision: 1,
      expectedAccessRevision: 1,
      redeemedAt: NOW,
      requestId: REQUEST_ID,
    });
    expect(proposal.grant).toMatchObject({
      grantId: `code-${ISSUANCE_ID}`,
      status: 'active',
      startsAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1_000,
    });
    expect(proposal.access.activeSources).toEqual([
      expect.objectContaining({ sourceId: `code-${ISSUANCE_ID}`, planKey: 'premium' }),
    ]);
    expect(proposal.audit).toMatchObject({
      targetKind: 'ACCESS_CODE',
      targetId: ISSUANCE_ID,
      action: 'access_code.redeemed',
      actor: OWNER,
      subject: `code-${ISSUANCE_ID}`,
    });
    const serializedAudit = JSON.stringify(proposal.audit);
    expect(serializedAudit).not.toContain(PLAINTEXT);
    expect(serializedAudit).not.toContain(code().secretMac);
    expect(serializedAudit).not.toContain('email');
  });

  it('materializes permanent Premium with no grant expiration', async () => {
    const permanentCode = code({
      grantMode: 'permanent',
      durationSeconds: null,
    });
    const { proposals, redeemer } = makeDeps({ readCode: vi.fn(async () => permanentCode) });

    await redeem(redeemer);

    expect(proposals[0].grant.expiresAt).toBeNull();
    expect(proposals[0].access.nextRecomputeAt).toBeNull();
  });

  it('returns current ACCESS for an authenticated retry by the original redeemer', async () => {
    const redeemed = code({ status: 'redeemed', redeemerSub: OWNER, redeemedAt: NOW - 1 });
    const grant = buildSponsoredGrant(redeemed, OWNER, NOW - 1);
    const premium = deriveAccessItem(OWNER, NOW, freeAccess(), [grant]);
    const { deps, redeemer } = makeDeps({
      readCode: vi.fn(async () => redeemed),
      readAccountSnapshot: vi.fn(async () => account({ access: premium, grants: [grant] })),
    });

    await expect(redeem(redeemer)).resolves.toEqual(premium);
    expect(deps.commitRedemption).not.toHaveBeenCalled();
  });

  it('resolves a transaction race only when the same caller became the winner', async () => {
    const issued = code();
    const redeemed = code({ status: 'redeemed', redeemerSub: OWNER, redeemedAt: NOW });
    const grant = buildSponsoredGrant(redeemed, OWNER, NOW);
    const premium = deriveAccessItem(OWNER, NOW, freeAccess(), [grant]);
    const readCode = vi.fn().mockResolvedValueOnce(issued).mockResolvedValueOnce(redeemed);
    const readAccountSnapshot = vi
      .fn()
      .mockResolvedValueOnce(account())
      .mockResolvedValueOnce(account({ access: premium, grants: [grant] }));
    const { redeemer } = makeDeps({
      readCode,
      readAccountSnapshot,
      commitRedemption: vi.fn(async () => 'conflict' as const),
    });

    await expect(redeem(redeemer)).resolves.toEqual(premium);
  });

  it('returns the generic invalid error when another account wins the transaction race', async () => {
    const readCode = vi
      .fn()
      .mockResolvedValueOnce(code())
      .mockResolvedValueOnce(code({ status: 'redeemed', redeemerSub: OTHER, redeemedAt: NOW }));
    const { redeemer } = makeDeps({
      readCode,
      commitRedemption: vi.fn(async () => 'conflict' as const),
    });

    await expect(redeem(redeemer)).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'ACCESS_CODE_INVALID');
      return true;
    });
  });
});
