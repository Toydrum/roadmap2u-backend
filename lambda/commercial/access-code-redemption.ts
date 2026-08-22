import { ApiError } from '@app/api/contracts';
import type { ProfileItem } from '../db';
import { deriveAccessItem } from './access-resolver';
import {
  accessCodeFingerprint,
  buildSponsoredGrant,
  parseAccessCode,
  verifyAccessCodeMac,
  type AccessCodeItem,
} from './access-codes';
import type { AuditEvent } from './audit';
import { isCommercialSwitchEnabled, type CommercialConfigResult } from './flags';
import type { AccessItem, GrantItem } from './model';

export type AccessCodeRedemptionMetric = 'success' | 'invalid' | 'rate_limited' | 'conflict';

export interface RedemptionAccountSnapshot {
  readonly profile?: ProfileItem;
  readonly closure?: Readonly<Record<string, unknown>>;
  readonly access?: AccessItem;
  readonly grants: readonly GrantItem[];
}

export interface RedemptionCommitProposal {
  readonly ownerSub: string;
  readonly issuanceId: string;
  readonly expectedCodeRevision: number;
  readonly expectedAccessRevision: number | null;
  readonly redeemedAt: number;
  readonly requestId: string;
  readonly grant: GrantItem;
  readonly access: AccessItem;
  readonly audit: AuditEvent;
}

export interface AccessCodeRedemptionDeps {
  readonly now: () => number;
  readonly resolveFlags: () => Promise<CommercialConfigResult>;
  /** This adapter atomically increments and permits counts one through five. */
  readonly consumeAttempt: (
    ownerSub: string,
    now: number,
  ) => Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
  >;
  readonly readCode: (issuanceId: string) => Promise<AccessCodeItem | undefined>;
  readonly readSecretKey: (version: string) => Promise<Uint8Array | undefined>;
  readonly readAccountSnapshot: (ownerSub: string) => Promise<RedemptionAccountSnapshot>;
  readonly commitRedemption: (
    proposal: RedemptionCommitProposal,
  ) => Promise<'committed' | 'conflict'>;
  readonly emitMetric: (metric: AccessCodeRedemptionMetric) => void;
}

export interface RedeemAccessCodeInput {
  readonly ownerSub: string;
  readonly emailVerified: boolean;
  readonly code: string;
  readonly requestId: string;
}

function isBoundedIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  );
}

function isCanonicalStoredCode(value: AccessCodeItem, issuanceId: string): boolean {
  return (
    value.pk === `ACCESS_CODE#${issuanceId}` &&
    value.sk === 'CODE' &&
    value.issuanceId === issuanceId &&
    (value.status === 'issued' || value.status === 'redeemed' || value.status === 'revoked') &&
    /^[A-Za-z0-9_-]{43}$/.test(value.secretMac) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value.secretKeyVersion) &&
    value.fingerprint === accessCodeFingerprint(issuanceId) &&
    value.grantOfferKey === 'premium_demo' &&
    value.planKey === 'premium' &&
    Number.isSafeInteger(value.redeemBy) &&
    value.redeemBy >= 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1
  );
}

function isEligibleProfile(
  snapshot: RedemptionAccountSnapshot,
  ownerSub: string,
  emailVerified: boolean,
): boolean {
  const profile = snapshot.profile;
  return Boolean(
    emailVerified &&
    profile &&
    profile.pk === `USER#${ownerSub}` &&
    profile.sk === 'PROFILE' &&
    profile.userId === ownerSub &&
    profile.accountType === 'adult' &&
    (profile.status === undefined || profile.status === 'active') &&
    typeof profile.email === 'string' &&
    profile.email.length > 0,
  );
}

function hasDeterministicGrant(
  snapshot: RedemptionAccountSnapshot,
  ownerSub: string,
  issuanceId: string,
): boolean {
  const grantId = `code-${issuanceId}`;
  return snapshot.grants.some(
    (grant) =>
      grant.ownerSub === ownerSub &&
      grant.pk === `USER#${ownerSub}` &&
      grant.sk === `GRANT#${grantId}` &&
      grant.grantId === grantId,
  );
}

function hasAccessSource(access: AccessItem | undefined, issuanceId: string): access is AccessItem {
  const grantId = `code-${issuanceId}`;
  return Boolean(
    access?.effectivePlanKey === 'premium' &&
    access.activeSources.some(
      (source) => source.kind === 'sponsored' && source.sourceId === grantId,
    ),
  );
}

export class AccessCodeRedeemer {
  constructor(private readonly deps: AccessCodeRedemptionDeps) {}

  async redeem(input: RedeemAccessCodeInput): Promise<AccessItem> {
    // No DynamoDB/config call happens until the bounded parser accepts all
    // segments. Every malformed shape still returns the same public error.
    const parsed = parseAccessCode(input.code);
    if (!parsed) return this.invalid();
    if (!isBoundedIdentity(input.ownerSub) || !isBoundedIdentity(input.requestId)) {
      throw new ApiError('UNAUTHENTICATED');
    }

    const config = await this.deps.resolveFlags();
    if (!isCommercialSwitchEnabled(config, 'redemption')) {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }

    const attempt = await this.deps.consumeAttempt(input.ownerSub, this.deps.now());
    if (!attempt.allowed) {
      this.deps.emitMetric('rate_limited');
      throw new ApiError('ACCESS_CODE_RATE_LIMITED');
    }

    const stored = await this.deps.readCode(parsed.issuanceId);
    if (!stored || !isCanonicalStoredCode(stored, parsed.issuanceId)) return this.invalid();

    let secretKey: Uint8Array | undefined;
    try {
      secretKey = await this.deps.readSecretKey(stored.secretKeyVersion);
    } catch {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
    if (!secretKey) throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    if (!verifyAccessCodeMac(parsed, stored.secretMac, secretKey)) return this.invalid();

    const now = this.deps.now();
    if (stored.status === 'redeemed') {
      if (stored.redeemerSub !== input.ownerSub) return this.invalid();
      const snapshot = await this.deps.readAccountSnapshot(input.ownerSub);
      this.assertEligible(snapshot, input);
      return this.idempotentAccess(snapshot, input.ownerSub, stored.issuanceId);
    }
    if (stored.status !== 'issued' || stored.redeemBy <= now) return this.invalid();

    const snapshot = await this.deps.readAccountSnapshot(input.ownerSub);
    this.assertEligible(snapshot, input);
    if (hasDeterministicGrant(snapshot, input.ownerSub, stored.issuanceId)) {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }

    const grant = buildSponsoredGrant(stored, input.ownerSub, now);
    const access = deriveAccessItem(input.ownerSub, now, snapshot.access, [
      ...snapshot.grants,
      grant,
    ]);
    const proposal: RedemptionCommitProposal = {
      ownerSub: input.ownerSub,
      issuanceId: stored.issuanceId,
      expectedCodeRevision: stored.revision,
      expectedAccessRevision: snapshot.access?.revision ?? null,
      redeemedAt: now,
      requestId: input.requestId,
      grant,
      access,
      audit: {
        targetKind: 'ACCESS_CODE',
        targetId: stored.issuanceId,
        timestamp: now,
        requestId: input.requestId,
        action: 'access_code.redeemed',
        actor: input.ownerSub,
        subject: grant.grantId,
        details: {
          fingerprint: stored.fingerprint,
          grantOfferKey: stored.grantOfferKey,
          grantMode: stored.grantMode,
          expiresAt: grant.expiresAt,
          reason: stored.reason,
        },
      },
    };

    const result = await this.deps.commitRedemption(proposal);
    if (result === 'committed') {
      this.deps.emitMetric('success');
      return access;
    }

    this.deps.emitMetric('conflict');
    const winner = await this.deps.readCode(parsed.issuanceId);
    if (winner?.status === 'redeemed' && winner.redeemerSub === input.ownerSub) {
      const after = await this.deps.readAccountSnapshot(input.ownerSub);
      this.assertEligible(after, input);
      return this.idempotentAccess(after, input.ownerSub, stored.issuanceId);
    }
    if (winner?.status === 'redeemed') return this.invalid();
    throw new ApiError('ACCESS_REVISION_CONFLICT');
  }

  private assertEligible(snapshot: RedemptionAccountSnapshot, input: RedeemAccessCodeInput): void {
    if (snapshot.closure || snapshot.profile?.status === 'closing') {
      throw new ApiError('CONFLICT', 'account closure is in progress');
    }
    if (!isEligibleProfile(snapshot, input.ownerSub, input.emailVerified)) {
      throw new ApiError('FORBIDDEN');
    }
  }

  private idempotentAccess(
    snapshot: RedemptionAccountSnapshot,
    ownerSub: string,
    issuanceId: string,
  ): AccessItem {
    if (
      !hasDeterministicGrant(snapshot, ownerSub, issuanceId) ||
      !hasAccessSource(snapshot.access, issuanceId)
    ) {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
    return snapshot.access;
  }

  private invalid(): never {
    this.deps.emitMetric('invalid');
    throw new ApiError('ACCESS_CODE_INVALID');
  }
}
