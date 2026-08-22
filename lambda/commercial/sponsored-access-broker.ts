import { ApiError } from '@app/api/contracts';
import { createHash } from 'node:crypto';
import { deriveAccessItem } from './access-resolver';
import {
  accessCodeCommandKey,
  buildIssuedAccessCode,
  generateAccessCode,
  parseAccessCode,
  publicAccessCodeMetadata,
  resolveAccessCodeTerms,
  computeAccessCodeMac,
  type AccessCodeCommandAction,
  type AccessCodeCommandItem,
  type AccessCodeItem,
  type AccessCodeMetadata,
} from './access-codes';
import type { AuditEvent } from './audit';
import { ADMIN_GRANT_OFFERS } from './catalog';
import { isCommercialSwitchEnabled, type CommercialConfigResult } from './flags';
import type { AccessItem, GrantItem } from './model';

interface MutatingCommandBase {
  readonly stage: string;
  readonly commandId: string;
  readonly reason: string;
  readonly confirmHash: string;
}

export interface IssueAccessCodeCommand extends MutatingCommandBase {
  readonly command: 'issue-code';
  readonly grantOfferKey: 'premium_demo';
  readonly permanent?: boolean;
  readonly confirmPermanent?: boolean;
  readonly durationSeconds?: number;
  readonly redeemWindowSeconds?: number;
}

export interface RevokeAccessCodeCommand extends MutatingCommandBase {
  readonly command: 'revoke-code';
  readonly issuanceId: string;
}

export interface ExtendSponsoredGrantCommand extends MutatingCommandBase {
  readonly command: 'extend-grant';
  readonly issuanceId: string;
  readonly newExpiresAt: number;
}

export interface RevokeSponsoredGrantCommand extends MutatingCommandBase {
  readonly command: 'revoke-grant';
  readonly issuanceId: string;
}

export interface SponsoredAccessMetadataCommand {
  readonly command: 'metadata';
  readonly stage: string;
  readonly issuanceId: string;
}

export type SponsoredAccessCommand =
  | IssueAccessCodeCommand
  | RevokeAccessCodeCommand
  | ExtendSponsoredGrantCommand
  | RevokeSponsoredGrantCommand
  | SponsoredAccessMetadataCommand;

type SponsoredAccessMutationCommand = Exclude<
  SponsoredAccessCommand,
  SponsoredAccessMetadataCommand
>;
type WithoutConfirmHash<T> = T extends unknown ? Omit<T, 'confirmHash'> : never;
export type UnsignedSponsoredAccessCommand = WithoutConfirmHash<SponsoredAccessMutationCommand>;

export interface SponsoredAccessBrokerContext {
  readonly actorArn: string;
  readonly requestId: string;
}

export interface SponsoredGrantSnapshot {
  readonly code: AccessCodeItem;
  readonly ownerSub: string;
  readonly grant: GrantItem;
  readonly grants: readonly GrantItem[];
  readonly access: AccessItem;
}

interface ProposalBase {
  readonly commandItem: AccessCodeCommandItem;
  readonly audit: AuditEvent;
}

export type SponsoredAccessBrokerProposal =
  | (ProposalBase & {
      readonly kind: 'issue-code';
      readonly code: AccessCodeItem;
    })
  | (ProposalBase & {
      readonly kind: 'revoke-code';
      readonly issuanceId: string;
      readonly expectedCodeRevision: number;
      readonly revokedAt: number;
      readonly revokedBy: string;
    })
  | (ProposalBase & {
      readonly kind: 'extend-grant';
      readonly ownerSub: string;
      readonly issuanceId: string;
      readonly expectedGrantRevision: number;
      readonly expectedAccessRevision: number;
      readonly grant: GrantItem;
      readonly access: AccessItem;
    })
  | (ProposalBase & {
      readonly kind: 'revoke-grant';
      readonly ownerSub: string;
      readonly issuanceId: string;
      readonly expectedGrantRevision: number;
      readonly expectedAccessRevision: number;
      readonly grant: GrantItem;
      readonly access: AccessItem;
    });

export interface SponsoredAccessBrokerDeps {
  readonly now: () => number;
  readonly resolveFlags: () => Promise<CommercialConfigResult>;
  readonly readCommand: (commandId: string) => Promise<AccessCodeCommandItem | undefined>;
  readonly readCode: (issuanceId: string) => Promise<AccessCodeItem | undefined>;
  readonly readGrantSnapshot: (issuanceId: string) => Promise<SponsoredGrantSnapshot | undefined>;
  readonly readActiveSecretKey: () => Promise<{
    readonly version: string;
    readonly key: Uint8Array;
  }>;
  readonly nextIssuanceId: () => string;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly commit: (proposal: SponsoredAccessBrokerProposal) => Promise<'committed' | 'conflict'>;
  readonly emitMetric: (metric: 'issued' | 'revoked' | 'extended' | 'conflict') => void;
  readonly allowlist: ReadonlyArray<{
    readonly accountId: string;
    readonly roleName: string;
    readonly stage: string;
    readonly commands: readonly SponsoredAccessCommand['command'][];
  }>;
}

export type SponsoredAccessBrokerResult =
  | {
      readonly command: 'issue-code';
      readonly metadata: AccessCodeMetadata;
      readonly plaintext?: string;
      readonly plaintextUnavailable: boolean;
      readonly idempotent: boolean;
    }
  | {
      readonly command: 'revoke-code';
      readonly metadata: AccessCodeMetadata;
      readonly idempotent: boolean;
    }
  | {
      readonly command: 'extend-grant' | 'revoke-grant';
      readonly metadata: SponsoredGrantMetadata;
      readonly idempotent: boolean;
    }
  | {
      readonly command: 'metadata';
      readonly metadata: AccessCodeMetadata;
      readonly grant?: SponsoredGrantMetadata;
    };

export interface SponsoredGrantMetadata {
  readonly issuanceId: string;
  readonly status: GrantItem['status'];
  readonly startsAt: number;
  readonly expiresAt: number | null;
  readonly revision: number;
  readonly revokedAt?: number;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STAGE_PATTERN = /^(?:dev|test|prod)$/;
const ASSUMED_ROLE_ARN_PATTERN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@-]{2,64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function sponsoredAccessCommandHash(command: UnsignedSponsoredAccessCommand): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(command)))
    .digest('hex');
}

function withoutConfirmHash(
  command: SponsoredAccessMutationCommand,
): UnsignedSponsoredAccessCommand {
  const { confirmHash: _confirmHash, ...unsigned } = command;
  return unsigned as UnsignedSponsoredAccessCommand;
}

function isBoundedReason(value: string): boolean {
  return value.length > 0 && value === value.trim() && Buffer.byteLength(value, 'utf8') <= 256;
}

function assertCommonCommand(
  command: SponsoredAccessCommand,
  context: SponsoredAccessBrokerContext,
): void {
  if (
    !STAGE_PATTERN.test(command.stage) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(context.requestId)
  ) {
    throw new ApiError('VALIDATION');
  }
  if (!ASSUMED_ROLE_ARN_PATTERN.test(context.actorArn)) throw new ApiError('FORBIDDEN');
  if (command.command !== 'issue-code' && !UUID_V4_PATTERN.test(command.issuanceId)) {
    throw new ApiError('VALIDATION');
  }
}

function isAllowed(
  deps: SponsoredAccessBrokerDeps,
  command: SponsoredAccessCommand,
  actorArn: string,
): boolean {
  const principal = ASSUMED_ROLE_ARN_PATTERN.exec(actorArn);
  if (!principal) return false;
  const [, accountId, roleName] = principal;
  return deps.allowlist.some(
    (entry) =>
      entry.accountId === accountId &&
      entry.roleName === roleName &&
      entry.stage === command.stage &&
      entry.commands.includes(command.command),
  );
}

function assertMutation(
  command: Exclude<SponsoredAccessCommand, SponsoredAccessMetadataCommand>,
): string {
  if (!UUID_V4_PATTERN.test(command.commandId) || !isBoundedReason(command.reason)) {
    throw new ApiError('VALIDATION');
  }
  const requestHash = sponsoredAccessCommandHash(withoutConfirmHash(command));
  if (!HASH_PATTERN.test(command.confirmHash) || command.confirmHash !== requestHash) {
    throw new ApiError('VALIDATION');
  }
  return requestHash;
}

function grantMetadata(issuanceId: string, grant: GrantItem): SponsoredGrantMetadata {
  return {
    issuanceId,
    status: grant.status,
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    revision: grant.revision,
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
  };
}

function commandItem(
  command: Exclude<SponsoredAccessCommand, SponsoredAccessMetadataCommand>,
  requestHash: string,
  actor: string,
  now: number,
  result: Readonly<Record<string, unknown>>,
): AccessCodeCommandItem {
  return {
    ...accessCodeCommandKey(command.commandId),
    commandId: command.commandId,
    action: command.command,
    requestHash,
    actor,
    reason: command.reason,
    status: 'committed',
    result,
    createdAt: now,
  };
}

function audit(
  context: SponsoredAccessBrokerContext,
  input: {
    readonly targetKind: string;
    readonly targetId: string;
    readonly timestamp: number;
    readonly action: string;
    readonly subject: string;
    readonly details: Readonly<Record<string, unknown>>;
  },
): AuditEvent {
  return {
    ...input,
    requestId: context.requestId,
    actor: context.actorArn,
  };
}

function replaceGrant(grants: readonly GrantItem[], replacement: GrantItem): GrantItem[] {
  return grants.map((grant) => (grant.grantId === replacement.grantId ? replacement : grant));
}

export class SponsoredAccessBroker {
  constructor(private readonly deps: SponsoredAccessBrokerDeps) {}

  async execute(
    command: SponsoredAccessCommand,
    context: SponsoredAccessBrokerContext,
  ): Promise<SponsoredAccessBrokerResult> {
    assertCommonCommand(command, context);
    if (!isAllowed(this.deps, command, context.actorArn)) throw new ApiError('FORBIDDEN');
    if (command.command === 'metadata') return this.metadata(command);

    const requestHash = assertMutation(command);
    const existing = await this.deps.readCommand(command.commandId);
    if (existing) return this.replay(existing, command, requestHash);

    if (command.command === 'issue-code') {
      return this.issue(command, context, requestHash);
    }
    if (command.command === 'revoke-code') {
      return this.revokeCode(command, context, requestHash);
    }
    return this.mutateGrant(command, context, requestHash);
  }

  private replay(
    existing: AccessCodeCommandItem,
    command: Exclude<SponsoredAccessCommand, SponsoredAccessMetadataCommand>,
    requestHash: string,
  ): SponsoredAccessBrokerResult {
    if (
      existing.commandId !== command.commandId ||
      existing.action !== command.command ||
      existing.requestHash !== requestHash ||
      existing.status !== 'committed'
    ) {
      throw new ApiError('CONFLICT');
    }
    const metadata = existing.result['metadata'];
    if (!metadata || typeof metadata !== 'object') {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
    if (command.command === 'issue-code') {
      return {
        command: 'issue-code',
        metadata: metadata as AccessCodeMetadata,
        plaintextUnavailable: true,
        idempotent: true,
      };
    }
    return {
      command: command.command,
      metadata: metadata as AccessCodeMetadata & SponsoredGrantMetadata,
      idempotent: true,
    } as SponsoredAccessBrokerResult;
  }

  private async requireIssuanceEnabled(): Promise<void> {
    const config = await this.deps.resolveFlags();
    if (!isCommercialSwitchEnabled(config, 'issuance')) {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
  }

  private async issue(
    command: IssueAccessCodeCommand,
    context: SponsoredAccessBrokerContext,
    requestHash: string,
  ): Promise<SponsoredAccessBrokerResult> {
    await this.requireIssuanceEnabled();
    if (command.grantOfferKey !== 'premium_demo') throw new ApiError('VALIDATION');
    let terms;
    try {
      terms = resolveAccessCodeTerms({
        ...(command.permanent === undefined ? {} : { permanent: command.permanent }),
        ...(command.confirmPermanent === undefined
          ? {}
          : { confirmPermanent: command.confirmPermanent }),
        ...(command.durationSeconds === undefined
          ? {}
          : { durationSeconds: command.durationSeconds }),
        ...(command.redeemWindowSeconds === undefined
          ? {}
          : { redeemWindowSeconds: command.redeemWindowSeconds }),
      });
    } catch {
      throw new ApiError('VALIDATION');
    }
    const now = this.deps.now();
    const issuanceId = this.deps.nextIssuanceId();
    const generated = generateAccessCode({
      issuanceId,
      randomBytes: this.deps.randomBytes,
    });
    const parsed = parseAccessCode(generated.plaintext);
    if (!parsed) throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    let secret;
    try {
      secret = await this.deps.readActiveSecretKey();
    } catch {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
    const code = buildIssuedAccessCode({
      issuanceId,
      secretMac: computeAccessCodeMac(parsed, secret.key),
      secretKeyVersion: secret.version,
      issuedAt: now,
      issuedBy: context.actorArn,
      reason: command.reason,
      terms,
      grantOfferKey: command.grantOfferKey,
    });
    const metadata = publicAccessCodeMetadata(code);
    const item = commandItem(command, requestHash, context.actorArn, now, { metadata });
    const proposal: SponsoredAccessBrokerProposal = {
      kind: 'issue-code',
      code,
      commandItem: item,
      audit: audit(context, {
        targetKind: 'ACCESS_CODE',
        targetId: issuanceId,
        timestamp: now,
        action: 'access_code.issued',
        subject: issuanceId,
        details: {
          fingerprint: code.fingerprint,
          grantOfferKey: code.grantOfferKey,
          grantMode: code.grantMode,
          durationSeconds: code.durationSeconds,
          redeemBy: code.redeemBy,
          reason: command.reason,
        },
      }),
    };
    const outcome = await this.deps.commit(proposal);
    if (outcome === 'conflict') return this.resolveConflict(command, requestHash);
    this.deps.emitMetric('issued');
    return {
      command: 'issue-code',
      metadata,
      plaintext: generated.plaintext,
      plaintextUnavailable: false,
      idempotent: false,
    };
  }

  private async revokeCode(
    command: RevokeAccessCodeCommand,
    context: SponsoredAccessBrokerContext,
    requestHash: string,
  ): Promise<SponsoredAccessBrokerResult> {
    const stored = await this.deps.readCode(command.issuanceId);
    if (!stored) throw new ApiError('NOT_FOUND');
    if (stored.status !== 'issued') throw new ApiError('CONFLICT');
    const now = this.deps.now();
    const revoked: AccessCodeItem = {
      ...stored,
      status: 'revoked',
      revokedAt: now,
      revokedBy: context.actorArn,
      updatedAt: now,
      revision: stored.revision + 1,
    };
    const metadata = publicAccessCodeMetadata(revoked);
    const item = commandItem(command, requestHash, context.actorArn, now, { metadata });
    const proposal: SponsoredAccessBrokerProposal = {
      kind: 'revoke-code',
      issuanceId: stored.issuanceId,
      expectedCodeRevision: stored.revision,
      revokedAt: now,
      revokedBy: context.actorArn,
      commandItem: item,
      audit: audit(context, {
        targetKind: 'ACCESS_CODE',
        targetId: stored.issuanceId,
        timestamp: now,
        action: 'access_code.revoked',
        subject: stored.issuanceId,
        details: { fingerprint: stored.fingerprint, reason: command.reason },
      }),
    };
    const outcome = await this.deps.commit(proposal);
    if (outcome === 'conflict') return this.resolveConflict(command, requestHash);
    this.deps.emitMetric('revoked');
    return { command: 'revoke-code', metadata, idempotent: false };
  }

  private async mutateGrant(
    command: ExtendSponsoredGrantCommand | RevokeSponsoredGrantCommand,
    context: SponsoredAccessBrokerContext,
    requestHash: string,
  ): Promise<SponsoredAccessBrokerResult> {
    if (command.command === 'extend-grant') await this.requireIssuanceEnabled();
    const snapshot = await this.deps.readGrantSnapshot(command.issuanceId);
    if (!snapshot) throw new ApiError('NOT_FOUND');
    const { code, ownerSub, grant, grants, access } = snapshot;
    if (
      code.status !== 'redeemed' ||
      code.redeemerSub !== ownerSub ||
      grant.grantId !== `code-${command.issuanceId}` ||
      grant.ownerSub !== ownerSub ||
      access.ownerSub !== ownerSub
    ) {
      throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    }
    const now = this.deps.now();
    let next: GrantItem;
    if (command.command === 'extend-grant') {
      const maxExpiresAt =
        grant.startsAt + ADMIN_GRANT_OFFERS.premium_demo.maxDurationSeconds * 1_000;
      if (
        grant.status !== 'active' ||
        grant.expiresAt === null ||
        grant.expiresAt <= now ||
        !Number.isSafeInteger(command.newExpiresAt) ||
        command.newExpiresAt <= grant.expiresAt ||
        command.newExpiresAt > maxExpiresAt
      ) {
        throw new ApiError('CONFLICT');
      }
      next = {
        ...grant,
        expiresAt: command.newExpiresAt,
        revision: grant.revision + 1,
        updatedAt: now,
      };
    } else {
      if (grant.status !== 'active') throw new ApiError('CONFLICT');
      next = {
        ...grant,
        status: 'revoked',
        revokedAt: now,
        revision: grant.revision + 1,
        updatedAt: now,
      };
    }
    const nextAccess = deriveAccessItem(ownerSub, now, access, replaceGrant(grants, next));
    const metadata = grantMetadata(command.issuanceId, next);
    const item = commandItem(command, requestHash, context.actorArn, now, { metadata });
    const proposal: SponsoredAccessBrokerProposal = {
      kind: command.command,
      ownerSub,
      issuanceId: command.issuanceId,
      expectedGrantRevision: grant.revision,
      expectedAccessRevision: access.revision,
      grant: next,
      access: nextAccess,
      commandItem: item,
      audit: audit(context, {
        targetKind: 'GRANT',
        targetId: grant.grantId,
        timestamp: now,
        action:
          command.command === 'extend-grant'
            ? 'sponsored_grant.extended'
            : 'sponsored_grant.revoked',
        subject: grant.grantId,
        details: {
          fingerprint: code.fingerprint,
          previousExpiresAt: grant.expiresAt,
          expiresAt: next.expiresAt,
          status: next.status,
          reason: command.reason,
        },
      }),
    };
    const outcome = await this.deps.commit(proposal);
    if (outcome === 'conflict') return this.resolveConflict(command, requestHash);
    this.deps.emitMetric(command.command === 'extend-grant' ? 'extended' : 'revoked');
    return { command: command.command, metadata, idempotent: false };
  }

  private async resolveConflict(
    command: Exclude<SponsoredAccessCommand, SponsoredAccessMetadataCommand>,
    requestHash: string,
  ): Promise<SponsoredAccessBrokerResult> {
    this.deps.emitMetric('conflict');
    const existing = await this.deps.readCommand(command.commandId);
    if (existing) return this.replay(existing, command, requestHash);
    throw new ApiError('CONFLICT');
  }

  private async metadata(
    command: SponsoredAccessMetadataCommand,
  ): Promise<SponsoredAccessBrokerResult> {
    const code = await this.deps.readCode(command.issuanceId);
    if (!code) throw new ApiError('NOT_FOUND');
    const metadata = publicAccessCodeMetadata(code);
    if (code.status !== 'redeemed') return { command: 'metadata', metadata };
    const snapshot = await this.deps.readGrantSnapshot(command.issuanceId);
    if (!snapshot) throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    return {
      command: 'metadata',
      metadata,
      grant: grantMetadata(command.issuanceId, snapshot.grant),
    };
  }
}
