import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ADMIN_GRANT_OFFERS, PREPAYMENT_CATALOG, type AdminGrantOfferKey } from './catalog';
import type { AccessCapabilities, AccessLimits, GrantItem } from './model';

export const ACCESS_CODE_VERSION = 'RM2U1' as const;
export const DEFAULT_GRANT_DURATION_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_REDEEM_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const MIN_GRANT_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_GRANT_DURATION_SECONDS = 5 * 365 * 24 * 60 * 60;
export const MIN_REDEEM_WINDOW_SECONDS = 60 * 60;
export const MAX_REDEEM_WINDOW_SECONDS = 30 * 24 * 60 * 60;
export const ACCESS_CODE_MAX_LENGTH = 256;
export const ACCESS_CODE_SECRET_BYTES = 32;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ABSENT_KEY_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

export type AccessCodeStatus = 'issued' | 'redeemed' | 'revoked';
export type AccessCodeGrantMode = 'temporary' | 'permanent';

export interface ParsedAccessCode {
  readonly version: typeof ACCESS_CODE_VERSION;
  readonly issuanceId: string;
  /** Deliberately non-enumerable so ordinary serialization cannot echo it. */
  readonly secret: Buffer;
}

export interface GeneratedAccessCode {
  readonly issuanceId: string;
  /** Returned only to the administrative response that issued it. */
  readonly plaintext: string;
}

export interface AccessCodeTerms {
  readonly mode: AccessCodeGrantMode;
  readonly durationSeconds: number | null;
  readonly redeemWindowSeconds: number;
}

export interface AccessCodeItem {
  readonly pk: string;
  readonly sk: 'CODE';
  readonly issuanceId: string;
  readonly status: AccessCodeStatus;
  readonly secretMac: string;
  readonly secretKeyVersion: string;
  readonly fingerprint: string;
  readonly grantOfferKey: AdminGrantOfferKey;
  readonly catalogVersion: string;
  readonly planKey: 'premium';
  readonly limits: AccessLimits;
  readonly capabilities: AccessCapabilities;
  readonly grantMode: AccessCodeGrantMode;
  readonly durationSeconds: number | null;
  readonly redeemBy: number;
  readonly reason: string;
  readonly issuedAt: number;
  readonly issuedBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly redeemerSub?: string;
  readonly redeemedAt?: number;
  readonly revokedAt?: number;
  readonly revokedBy?: string;
}

export type AccessCodeCommandAction =
  'issue-code' | 'revoke-code' | 'extend-grant' | 'revoke-grant';

export interface AccessCodeCommandItem {
  readonly pk: 'ADMIN#SPONSORED';
  readonly sk: `COMMAND#${string}`;
  readonly commandId: string;
  readonly action: AccessCodeCommandAction;
  readonly requestHash: string;
  readonly actor: string;
  readonly reason: string;
  readonly status: 'committed';
  readonly result: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface AccessCodeMetadata {
  readonly issuanceId: string;
  readonly status: AccessCodeStatus;
  readonly grantOfferKey: AdminGrantOfferKey;
  readonly planKey: 'premium';
  readonly grantMode: AccessCodeGrantMode;
  readonly durationSeconds: number | null;
  readonly redeemBy: number;
  readonly issuedAt: number;
  readonly redeemedAt?: number;
  readonly revokedAt?: number;
}

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNonBlank(value: string, maxBytes: number): boolean {
  return value.length > 0 && value === value.trim() && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function requireIssuanceId(issuanceId: string): void {
  if (!UUID_V4_PATTERN.test(issuanceId)) throw new Error('invalid issuance id');
}

export function accessCodeKey(issuanceId: string): { pk: string; sk: 'CODE' } {
  requireIssuanceId(issuanceId);
  return { pk: `ACCESS_CODE#${issuanceId}`, sk: 'CODE' };
}

export function accessCodeCommandKey(commandId: string): {
  pk: 'ADMIN#SPONSORED';
  sk: `COMMAND#${string}`;
} {
  if (!UUID_V4_PATTERN.test(commandId)) throw new Error('invalid command id');
  return { pk: 'ADMIN#SPONSORED', sk: `COMMAND#${commandId}` };
}

export function accessCodeAttemptKey(ownerSub: string, now: number): { pk: string; sk: string } {
  if (!isBoundedNonBlank(ownerSub, 128) || !isSafeTimestamp(now)) {
    throw new Error('invalid access-code attempt key');
  }
  return {
    pk: `USER#${ownerSub}`,
    sk: `ACCESS_CODE_ATTEMPT#${new Date(now).toISOString().slice(0, 13)}`,
  };
}

export function parseAccessCode(value: unknown): ParsedAccessCode | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ACCESS_CODE_MAX_LENGTH ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    return null;
  }
  const segments = value.split('.');
  if (segments.length !== 3 || segments[0] !== ACCESS_CODE_VERSION) return null;
  const issuanceId = segments[1];
  const encodedSecret = segments[2];
  if (!UUID_V4_PATTERN.test(issuanceId) || !SECRET_PATTERN.test(encodedSecret)) return null;

  let secret: Buffer;
  try {
    secret = Buffer.from(encodedSecret, 'base64url');
  } catch {
    return null;
  }
  if (secret.length < 16 || secret.length > 64 || secret.toString('base64url') !== encodedSecret) {
    return null;
  }

  const parsed = { version: ACCESS_CODE_VERSION, issuanceId } as ParsedAccessCode;
  Object.defineProperty(parsed, 'secret', {
    value: Buffer.from(secret),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(parsed);
}

export function generateAccessCode(options: {
  readonly issuanceId: string;
  readonly randomBytes?: (size: number) => Uint8Array;
}): GeneratedAccessCode {
  requireIssuanceId(options.issuanceId);
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const secret = Buffer.from(randomBytes(ACCESS_CODE_SECRET_BYTES));
  if (secret.length !== ACCESS_CODE_SECRET_BYTES) {
    throw new Error('access-code entropy source returned the wrong length');
  }
  return {
    issuanceId: options.issuanceId,
    plaintext: `${ACCESS_CODE_VERSION}.${options.issuanceId}.${secret.toString('base64url')}`,
  };
}

function macInput(parsed: ParsedAccessCode): Buffer {
  return Buffer.concat([
    Buffer.from(`${parsed.version}\0${parsed.issuanceId}\0`, 'ascii'),
    parsed.secret,
  ]);
}

function requireHmacKey(key: Uint8Array): Buffer {
  const normalized = Buffer.from(key);
  if (normalized.length < 32) throw new Error('access-code HMAC key is too short');
  return normalized;
}

export function computeAccessCodeMac(parsed: ParsedAccessCode, key: Uint8Array): string {
  return createHmac('sha256', requireHmacKey(key)).update(macInput(parsed)).digest('base64url');
}

export function verifyAccessCodeMac(
  parsed: ParsedAccessCode,
  expectedMac: string,
  key: Uint8Array,
): boolean {
  if (!MAC_PATTERN.test(expectedMac)) return false;
  const expected = Buffer.from(expectedMac, 'base64url');
  const actual = Buffer.from(computeAccessCodeMac(parsed, key), 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function resolveAccessCodeTerms(input: {
  readonly permanent?: boolean;
  readonly confirmPermanent?: boolean;
  readonly durationSeconds?: number;
  readonly redeemWindowSeconds?: number;
}): AccessCodeTerms {
  const redeemWindowSeconds = input.redeemWindowSeconds ?? DEFAULT_REDEEM_WINDOW_SECONDS;
  if (
    !Number.isSafeInteger(redeemWindowSeconds) ||
    redeemWindowSeconds < MIN_REDEEM_WINDOW_SECONDS ||
    redeemWindowSeconds > MAX_REDEEM_WINDOW_SECONDS
  ) {
    throw new Error('invalid access-code terms');
  }

  if (input.permanent === true) {
    if (input.confirmPermanent !== true) {
      throw new Error('permanent access requires confirmation');
    }
    if (input.durationSeconds !== undefined) throw new Error('invalid access-code terms');
    return { mode: 'permanent', durationSeconds: null, redeemWindowSeconds };
  }

  if (input.confirmPermanent === true) throw new Error('invalid access-code terms');
  const durationSeconds = input.durationSeconds ?? DEFAULT_GRANT_DURATION_SECONDS;
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < MIN_GRANT_DURATION_SECONDS ||
    durationSeconds > MAX_GRANT_DURATION_SECONDS
  ) {
    throw new Error('invalid access-code terms');
  }
  return { mode: 'temporary', durationSeconds, redeemWindowSeconds };
}

export function accessCodeFingerprint(issuanceId: string): string {
  requireIssuanceId(issuanceId);
  return createHash('sha256')
    .update(`roadmap2u-access-code\0${issuanceId}`, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

export function buildIssuedAccessCode(input: {
  readonly issuanceId: string;
  readonly secretMac: string;
  readonly secretKeyVersion: string;
  readonly issuedAt: number;
  readonly issuedBy: string;
  readonly reason: string;
  readonly terms: AccessCodeTerms;
  readonly grantOfferKey?: AdminGrantOfferKey;
}): AccessCodeItem {
  const key = accessCodeKey(input.issuanceId);
  if (
    !MAC_PATTERN.test(input.secretMac) ||
    !KEY_VERSION_PATTERN.test(input.secretKeyVersion) ||
    !isSafeTimestamp(input.issuedAt) ||
    !isBoundedNonBlank(input.issuedBy, 256) ||
    !isBoundedNonBlank(input.reason, 256)
  ) {
    throw new Error('invalid issued access code');
  }
  const grantOfferKey = input.grantOfferKey ?? 'premium_demo';
  const offer = ADMIN_GRANT_OFFERS[grantOfferKey];
  if (!offer) throw new Error('invalid grant offer');
  if (
    input.terms.mode === 'temporary' &&
    (input.terms.durationSeconds === null ||
      input.terms.durationSeconds < offer.minDurationSeconds ||
      input.terms.durationSeconds > offer.maxDurationSeconds)
  ) {
    throw new Error('invalid access-code terms');
  }
  if (input.terms.mode === 'permanent' && input.terms.durationSeconds !== null) {
    throw new Error('invalid access-code terms');
  }
  const plan = PREPAYMENT_CATALOG.plans[offer.planKey];

  return {
    ...key,
    issuanceId: input.issuanceId,
    status: 'issued',
    secretMac: input.secretMac,
    secretKeyVersion: input.secretKeyVersion,
    fingerprint: accessCodeFingerprint(input.issuanceId),
    grantOfferKey,
    catalogVersion: offer.catalogVersion,
    planKey: 'premium',
    limits: { ...plan.limits },
    capabilities: { ...plan.capabilities, family: false },
    grantMode: input.terms.mode,
    durationSeconds: input.terms.durationSeconds,
    redeemBy: input.issuedAt + input.terms.redeemWindowSeconds * 1_000,
    reason: input.reason,
    issuedAt: input.issuedAt,
    issuedBy: input.issuedBy,
    createdAt: input.issuedAt,
    updatedAt: input.issuedAt,
    revision: 1,
  };
}

export function buildSponsoredGrant(
  code: AccessCodeItem,
  ownerSub: string,
  redeemedAt: number,
): GrantItem {
  if (
    !isBoundedNonBlank(ownerSub, 128) ||
    !isSafeTimestamp(redeemedAt) ||
    redeemedAt < code.issuedAt ||
    code.planKey !== 'premium'
  ) {
    throw new Error('invalid sponsored grant');
  }
  const grantId = `code-${code.issuanceId}`;
  const expiresAt =
    code.durationSeconds === null ? null : redeemedAt + code.durationSeconds * 1_000;
  return {
    pk: `USER#${ownerSub}`,
    sk: `GRANT#${grantId}`,
    ownerSub,
    grantId,
    sourceKind: 'sponsored',
    status: 'active',
    catalogVersion: code.catalogVersion,
    planKey: code.planKey,
    limits: { ...code.limits },
    capabilities: { ...code.capabilities, family: false },
    startsAt: redeemedAt,
    expiresAt,
    revision: 1,
    reason: code.reason,
    createdAt: redeemedAt,
    updatedAt: redeemedAt,
  };
}

export function publicAccessCodeMetadata(code: AccessCodeItem): AccessCodeMetadata {
  return {
    issuanceId: code.issuanceId,
    status: code.status,
    grantOfferKey: code.grantOfferKey,
    planKey: code.planKey,
    grantMode: code.grantMode,
    durationSeconds: code.durationSeconds,
    redeemBy: code.redeemBy,
    issuedAt: code.issuedAt,
    ...(code.redeemedAt === undefined ? {} : { redeemedAt: code.redeemedAt }),
    ...(code.revokedAt === undefined ? {} : { revokedAt: code.revokedAt }),
  };
}

export function accessCodeCommandPut(item: AccessCodeCommandItem) {
  return {
    Put: {
      Item: item,
      ConditionExpression: ABSENT_KEY_CONDITION,
    },
  };
}
