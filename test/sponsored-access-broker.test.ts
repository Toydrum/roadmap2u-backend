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
  type AccessCodeCommandItem,
  type AccessCodeItem,
} from '../lambda/commercial/access-codes';
import {
  SponsoredAccessBroker,
  sponsoredAccessCommandHash,
  type SponsoredAccessBrokerDeps,
  type SponsoredAccessBrokerProposal,
  type SponsoredAccessCommand,
  type UnsignedSponsoredAccessCommand,
} from '../lambda/commercial/sponsored-access-broker';
import type { CommercialConfigResult, CommercialFlags } from '../lambda/commercial/flags';
import type { AccessItem, GrantItem } from '../lambda/commercial/model';

const NOW = Date.parse('2026-08-22T18:30:00.000Z');
const STAGE = 'dev';
const ACCOUNT_ID = '123456789012';
const ROLE = 'SponsoredAccessOperator-dev';
const ACTOR = `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE}/operator-session`;
const COMMAND_ID = 'e3850eda-32e1-4b2b-a1bf-233226881128';
const ISSUANCE_ID = '7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a';
const OWNER = 'sub-adult';
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
      updatedBy: ACTOR,
      reason: 'test',
      ...overrides,
    },
  };
}

function issuedCode(overrides: Partial<AccessCodeItem> = {}): AccessCodeItem {
  const parsed = parseAccessCode(PLAINTEXT)!;
  return {
    ...buildIssuedAccessCode({
      issuanceId: ISSUANCE_ID,
      secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
      secretKeyVersion: 'v1',
      issuedAt: NOW - 60_000,
      issuedBy: ACTOR,
      reason: 'beta',
      terms: resolveAccessCodeTerms({}),
    }),
    ...overrides,
  };
}

function premiumSnapshot(overrides: Partial<GrantItem> = {}) {
  const redeemed = issuedCode({
    status: 'redeemed',
    redeemerSub: OWNER,
    redeemedAt: NOW - 10_000,
  });
  const grant: GrantItem = {
    ...buildSponsoredGrant(redeemed, OWNER, NOW - 10_000),
    ...overrides,
  };
  const free = deriveAccessItem(OWNER, NOW - 20_000, undefined, []);
  const access = deriveAccessItem(OWNER, NOW - 5_000, free, [grant]);
  return { code: redeemed, ownerSub: OWNER, grant, grants: [grant], access };
}

function makeDeps(overrides: Partial<SponsoredAccessBrokerDeps> = {}) {
  const proposals: SponsoredAccessBrokerProposal[] = [];
  const deps: SponsoredAccessBrokerDeps = {
    now: () => NOW,
    resolveFlags: vi.fn(async () => flags()),
    readCommand: vi.fn(async () => undefined),
    readCode: vi.fn(async () => issuedCode()),
    readGrantSnapshot: vi.fn(async () => premiumSnapshot()),
    readActiveSecretKey: vi.fn(async () => ({ version: 'v1', key: HMAC_KEY })),
    nextIssuanceId: vi.fn(() => ISSUANCE_ID),
    randomBytes: vi.fn(() => SECRET),
    commit: vi.fn(async (proposal) => {
      proposals.push(proposal);
      return 'committed' as const;
    }),
    emitMetric: vi.fn(),
    allowlist: [
      {
        accountId: ACCOUNT_ID,
        roleName: ROLE,
        stage: STAGE,
        commands: ['issue-code', 'revoke-code', 'extend-grant', 'revoke-grant', 'metadata'],
      },
    ],
    ...overrides,
  };
  return { deps, proposals, broker: new SponsoredAccessBroker(deps) };
}

function signed<T extends UnsignedSponsoredAccessCommand>(request: T): T & { confirmHash: string } {
  return { ...request, confirmHash: sponsoredAccessCommandHash(request) };
}

function issueCommand(overrides: Record<string, unknown> = {}) {
  return signed({
    command: 'issue-code' as const,
    stage: STAGE,
    commandId: COMMAND_ID,
    reason: 'beta tester 1',
    grantOfferKey: 'premium_demo' as const,
    ...overrides,
  } as Omit<Extract<SponsoredAccessCommand, { command: 'issue-code' }>, 'confirmHash'>);
}

function expectApiError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describe('SponsoredAccessBroker', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects callers outside the stage-scoped IAM role allowlist', async () => {
    const { deps, broker } = makeDeps();

    await expect(
      broker.execute(issueCommand(), {
        actorArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/OtherRole/session`,
        requestId: 'request-1',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'FORBIDDEN');
      return true;
    });
    expect(deps.resolveFlags).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'unavailable', reason: 'missing' } satisfies CommercialConfigResult,
    flags({ accessCodeIssuanceEnabled: false }),
  ])('fails closed when issuance is not authorized by configuration', async (config) => {
    const { deps, broker } = makeDeps({ resolveFlags: vi.fn(async () => config) });

    await expect(
      broker.execute(issueCommand(), { actorArn: ACTOR, requestId: 'request-1' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'COMMERCIAL_CONFIGURATION_UNAVAILABLE');
      return true;
    });
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('issues one code, persists only HMAC, and returns plaintext exactly on the winning commit', async () => {
    const { proposals, broker } = makeDeps();

    const result = await broker.execute(issueCommand(), {
      actorArn: ACTOR,
      requestId: 'request-1',
    });

    expect(result).toMatchObject({
      command: 'issue-code',
      plaintext: PLAINTEXT,
      plaintextUnavailable: false,
      metadata: { issuanceId: ISSUANCE_ID, status: 'issued', grantMode: 'temporary' },
    });
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal.kind).toBe('issue-code');
    if (proposal.kind !== 'issue-code') throw new Error('wrong proposal');
    expect(proposal.code.secretMac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proposal.code).not.toHaveProperty('plaintext');
    expect(proposal.code).not.toHaveProperty('targetSub');
    const persisted = JSON.stringify({ command: proposal.commandItem, audit: proposal.audit });
    expect(persisted).not.toContain(PLAINTEXT);
    expect(persisted).not.toContain(proposal.code.secretMac);
  });

  it('returns metadata with plaintextUnavailable on an idempotent issue retry', async () => {
    const first = makeDeps();
    const request = issueCommand();
    await first.broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' });
    const proposal = first.proposals[0];
    if (proposal.kind !== 'issue-code') throw new Error('wrong proposal');
    const { deps, broker } = makeDeps({
      readCommand: vi.fn(async () => proposal.commandItem),
    });

    const retry = await broker.execute(request, { actorArn: ACTOR, requestId: 'request-2' });

    expect(retry).toMatchObject({
      command: 'issue-code',
      plaintextUnavailable: true,
      metadata: { issuanceId: ISSUANCE_ID },
    });
    expect(retry).not.toHaveProperty('plaintext');
    expect(deps.readActiveSecretKey).not.toHaveBeenCalled();
    expect(deps.randomBytes).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('rejects a commandId replay whose canonical request hash changed', async () => {
    const request = issueCommand();
    const existing: AccessCodeCommandItem = {
      pk: 'ADMIN#SPONSORED',
      sk: `COMMAND#${COMMAND_ID}`,
      commandId: COMMAND_ID,
      action: 'issue-code',
      requestHash: '0'.repeat(64),
      actor: ACTOR,
      reason: 'other',
      status: 'committed',
      result: {},
      createdAt: NOW,
    };
    const { broker } = makeDeps({ readCommand: vi.fn(async () => existing) });

    await expect(
      broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'CONFLICT');
      return true;
    });
  });

  it('requires explicit permanent confirmation and stores a permanent issuance', async () => {
    const { proposals, broker } = makeDeps();
    const request = issueCommand({ permanent: true, confirmPermanent: true });

    const result = await broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' });

    expect(result).toMatchObject({ metadata: { grantMode: 'permanent', durationSeconds: null } });
    const proposal = proposals[0];
    if (proposal.kind !== 'issue-code') throw new Error('wrong proposal');
    expect(proposal.code.durationSeconds).toBeNull();
  });

  it('revokes an issued code without deleting its history', async () => {
    const request = signed({
      command: 'revoke-code' as const,
      stage: STAGE,
      commandId: COMMAND_ID,
      reason: 'delivery channel compromised',
      issuanceId: ISSUANCE_ID,
    });
    const { proposals, broker } = makeDeps();

    const result = await broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' });

    expect(result).toMatchObject({ command: 'revoke-code', metadata: { status: 'revoked' } });
    expect(proposals[0]).toMatchObject({
      kind: 'revoke-code',
      issuanceId: ISSUANCE_ID,
      expectedCodeRevision: 1,
      revokedAt: NOW,
    });
  });

  it('extends only an active temporary grant forward and refreshes ACCESS', async () => {
    const snapshot = premiumSnapshot();
    const newExpiresAt = snapshot.grant.expiresAt! + 24 * 60 * 60 * 1_000;
    const request = signed({
      command: 'extend-grant' as const,
      stage: STAGE,
      commandId: COMMAND_ID,
      reason: 'beta extension',
      issuanceId: ISSUANCE_ID,
      newExpiresAt,
    });
    const { proposals, broker } = makeDeps({
      readGrantSnapshot: vi.fn(async () => snapshot),
    });

    const result = await broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' });

    expect(result).toMatchObject({
      command: 'extend-grant',
      metadata: { issuanceId: ISSUANCE_ID, expiresAt: newExpiresAt },
    });
    const proposal = proposals[0];
    if (proposal.kind !== 'extend-grant') throw new Error('wrong proposal');
    expect(proposal.grant).toMatchObject({ revision: 2, expiresAt: newExpiresAt });
    expect(proposal.access.nextRecomputeAt).toBe(newExpiresAt);
  });

  it.each([
    ['permanent', { expiresAt: null }],
    ['revoked', { status: 'revoked' as const, revokedAt: NOW - 1 }],
    ['expired', { expiresAt: NOW }],
  ])('does not extend a %s grant', async (_label, grantOverride) => {
    const snapshot = premiumSnapshot(grantOverride);
    const request = signed({
      command: 'extend-grant' as const,
      stage: STAGE,
      commandId: COMMAND_ID,
      reason: 'invalid extension',
      issuanceId: ISSUANCE_ID,
      newExpiresAt: NOW + 10 * 24 * 60 * 60 * 1_000,
    });
    const { deps, broker } = makeDeps({ readGrantSnapshot: vi.fn(async () => snapshot) });

    await expect(
      broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectApiError(error, 'CONFLICT');
      return true;
    });
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('revokes a redeemed grant and immediately derives Free ACCESS', async () => {
    const snapshot = premiumSnapshot();
    const request = signed({
      command: 'revoke-grant' as const,
      stage: STAGE,
      commandId: COMMAND_ID,
      reason: 'beta access ended',
      issuanceId: ISSUANCE_ID,
    });
    const { proposals, broker } = makeDeps({
      readGrantSnapshot: vi.fn(async () => snapshot),
    });

    const result = await broker.execute(request, { actorArn: ACTOR, requestId: 'request-1' });

    expect(result).toMatchObject({ command: 'revoke-grant', metadata: { status: 'revoked' } });
    const proposal = proposals[0];
    if (proposal.kind !== 'revoke-grant') throw new Error('wrong proposal');
    expect(proposal.grant).toMatchObject({ status: 'revoked', revision: 2, revokedAt: NOW });
    expect(proposal.access.effectivePlanKey).toBe('free');
  });

  it('returns code and grant metadata without secrets or account identity', async () => {
    const snapshot = premiumSnapshot();
    const { broker } = makeDeps({
      readCode: vi.fn(async () => snapshot.code),
      readGrantSnapshot: vi.fn(async () => snapshot),
    });

    const result = await broker.execute(
      { command: 'metadata', stage: STAGE, issuanceId: ISSUANCE_ID },
      { actorArn: ACTOR, requestId: 'request-1' },
    );

    const json = JSON.stringify(result);
    expect(result).toMatchObject({
      command: 'metadata',
      metadata: { issuanceId: ISSUANCE_ID, status: 'redeemed' },
      grant: { status: 'active' },
    });
    expect(json).not.toContain(snapshot.code.secretMac);
    expect(json).not.toContain(OWNER);
    expect(json).not.toContain('redeemerSub');
  });
});
