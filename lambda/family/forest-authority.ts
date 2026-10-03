import { ApiError } from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { closureAbsenceConditionCheck, requireWritableOwner, type Ctx } from '../authz';
import { GetCommand, K, type ProfileItem } from '../db';
import { authorizeForestVisit } from '../social/policy';
import { assertFamilyIdentifier, FK } from './keys';
import { FamilyDomainError, type CoverageAssignmentItem } from './model';
import { readHouseholdSnapshot } from './repository';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type AuthorityFact = Readonly<{
  pk: string;
  sk: string;
  [field: string]: string | number | null | undefined;
}>;

/** Only the facts granting this adult write access to this exact minor. */
export interface ForestWriteAuthority {
  readonly actorId: string;
  readonly minorId: string;
  readonly validUntil: number;
  readonly facts: readonly AuthorityFact[];
}

function exactProfile(profile: ProfileItem, id: string, type: 'adult' | 'minor'): boolean {
  return profile.pk === K.user(id) && profile.sk === 'PROFILE' &&
    profile.userId === id && profile.accountType === type;
}

function coverageFact(coverage: CoverageAssignmentItem): AuthorityFact {
  const { pk, sk, entityType, accountId, householdId, seatType, state, revision, paidThrough, graceUntil, source } = coverage;
  return { pk, sk, entityType, accountId, householdId, seatType, state, revision, paidThrough, graceUntil, source };
}

/** Strongly resolve scope; an absent/ineligible target is always NOT_FOUND. */
export async function requireForestWriteAuthority(
  ctx: Ctx,
  minorId: string,
): Promise<ForestWriteAuthority> {
  if (ctx.callerId === minorId) throw new ApiError('NOT_FOUND');
  try {
    assertFamilyIdentifier(minorId, 'minorId');
  } catch {
    throw new ApiError('NOT_FOUND');
  }
  try {
    const [actor, minor] = await Promise.all([
      requireWritableOwner(ctx, ctx.callerId), requireWritableOwner(ctx, minorId),
    ]);
    if (!exactProfile(actor, ctx.callerId, 'adult') || !exactProfile(minor, minorId, 'minor')) {
      throw new ApiError('NOT_FOUND');
    }
    const majority = Date.parse(`${minor.majorityAt}T00:00:00.000Z`);
    if (
      !Number.isFinite(majority) ||
      new Date(majority).toISOString().slice(0, 10) !== minor.majorityAt ||
      majority <= ctx.deps.now()
    ) {
      throw new ApiError('NOT_FOUND');
    }
    const key = FK.familyCoverage(minorId);
    const result = await ctx.deps.ddb.send(new GetCommand({
      TableName: ctx.deps.table, Key: key, ConsistentRead: true,
    }));
    const locator = result.Item as CoverageAssignmentItem | undefined;
    if (
      !locator || locator.pk !== key.pk || locator.sk !== key.sk ||
      locator.entityType !== 'CoverageAssignment' || locator.accountId !== minorId ||
      locator.seatType !== 'minor' || typeof locator.householdId !== 'string'
    ) {
      throw new ApiError('NOT_FOUND');
    }
    try {
      assertFamilyIdentifier(locator.householdId, 'householdId');
    } catch {
      throw new ApiError('NOT_FOUND');
    }
    const snapshot = await readHouseholdSnapshot({
      ddb: ctx.deps.ddb, tableName: ctx.deps.table, now: ctx.deps.now,
    }, locator.householdId);
    if (!snapshot || snapshot.household.householdId !== locator.householdId) {
      throw new ApiError('NOT_FOUND');
    }
    const person = (profile: ProfileItem) => ({
      accountId: profile.userId, accountType: profile.accountType,
      status: profile.status ?? 'active', socialEnabled: profile.socialEnabled,
      ...(profile.majorityAt ? { majorityAt: profile.majorityAt } : {}),
    });
    const decision = authorizeForestVisit({
      actor: person(actor), target: person(minor), household: snapshot, now: ctx.deps.now(),
    });
    if (
      !decision.allowed ||
      (decision.relationship !== 'primary_supervision' && decision.relationship !== 'additional_supervision')
    ) {
      throw new ApiError('NOT_FOUND');
    }
    const role = decision.relationship === 'primary_supervision'
      ? 'primary_responsible' : 'additional_responsible';
    const seat = snapshot.seats.find((row) =>
      row.seatType === 'minor' && row.state === 'assigned' && row.accountId === minorId,
    );
    const additionalSeat = role === 'additional_responsible'
      ? snapshot.seats.find((row) =>
          row.seatType === 'additional_responsible' && row.state === 'assigned' && row.accountId === actor.userId,
        )
      : undefined;
    const link = snapshot.supervisionLinks.find((row) => row.minorId === minorId &&
      row.adultId === actor.userId && row.role === role && row.state === 'active' &&
      row.validUntil === null && row.validFrom <= ctx.deps.now());
    const actorCoverage = snapshot.coverages.find((row) =>
      row.accountId === actor.userId && row.seatType === role && row.state !== 'ended' &&
      row.householdId === snapshot.household.householdId,
    );
    // Ended coverage is only a locator, but it must still identify this household.
    const minorCoverage = snapshot.coverages.find((row) =>
      row.accountId === minorId && row.seatType === 'minor' &&
      row.householdId === snapshot.household.householdId,
    );
    if (
      !seat || seat.seatType !== 'minor' || !link || !actorCoverage || !minorCoverage ||
      (role === 'additional_responsible' && !additionalSeat)
    ) {
      throw new ApiError('NOT_FOUND');
    }
    const household = snapshot.household;
    const authority: ForestWriteAuthority = {
      actorId: actor.userId, minorId,
      validUntil: Math.min(
        majority,
        actorCoverage.state === 'grace' ? actorCoverage.graceUntil! : actorCoverage.paidThrough ?? majority,
      ),
      facts: [
        { ...K.profile(actor.userId), userId: actor.userId, accountType: 'adult', status: actor.status },
        { ...K.profile(minorId), userId: minorId, accountType: 'minor', status: minor.status, majorityAt: minor.majorityAt },
        { pk: household.pk, sk: household.sk, entityType: household.entityType,
          householdId: household.householdId, primaryResponsibleId: household.primaryResponsibleId,
          state: household.state, revision: household.revision },
        { pk: seat.pk, sk: seat.sk, entityType: seat.entityType, householdId: seat.householdId,
          seatType: seat.seatType, seatNumber: seat.seatNumber, state: seat.state,
          accountId: seat.accountId, revision: seat.revision },
        { pk: link.pk, sk: link.sk, entityType: link.entityType, householdId: link.householdId,
          linkId: link.linkId, adultId: link.adultId, minorId: link.minorId, role: link.role,
          state: link.state, revision: link.revision, validFrom: link.validFrom, validUntil: link.validUntil },
        coverageFact(actorCoverage), coverageFact(minorCoverage),
        ...(additionalSeat ? [{
          pk: additionalSeat.pk, sk: additionalSeat.sk, entityType: additionalSeat.entityType,
          householdId: additionalSeat.householdId, seatType: additionalSeat.seatType,
          accountId: additionalSeat.accountId, state: additionalSeat.state, revision: additionalSeat.revision,
        }] : []),
      ],
    };
    assertCurrentAuthority(authority, ctx.deps.now());
    return authority;
  } catch (error) {
    if (error instanceof FamilyDomainError || (error instanceof ApiError && error.code === 'CONFLICT')) {
      throw new ApiError('NOT_FOUND');
    }
    throw error;
  }
}

function assertCurrentAuthority(authority: ForestWriteAuthority, now: number): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(authority.validUntil) || authority.validUntil <= now) {
    throw new ApiError('NOT_FOUND');
  }
}

/** A retry or private conflict response must retain exactly the original authority. */
export async function recheckForestWriteAuthority(
  ctx: Ctx,
  expected: ForestWriteAuthority,
): Promise<void> {
  const current = await requireForestWriteAuthority(ctx, expected.minorId);
  if (JSON.stringify(current.facts) !== JSON.stringify(expected.facts)) throw new ApiError('NOT_FOUND');
}

/** Keep commercial guards and add supervision guards without duplicate DynamoDB keys. */
export function withForestWriteAuthority(
  ctx: Ctx,
  authority: ForestWriteAuthority,
  items: readonly TransactItem[],
): TransactItem[] {
  assertCurrentAuthority(authority, ctx.deps.now());
  const checks: TransactItem[] = authority.facts.map(({ pk, sk, ...fields }) => {
    const names: Record<string, string> = {};
    const values: Record<string, string | number | null> = {};
    const conditions = ['attribute_exists(pk)'];
    for (const [field, value] of Object.entries(fields)) {
      names[`#scope_${field}`] = field;
      if (value === undefined) conditions.push(`attribute_not_exists(#scope_${field})`);
      else {
        values[`:scope_${field}`] = value;
        conditions.push(`#scope_${field} = :scope_${field}`);
      }
    }
    return { ConditionCheck: {
      TableName: ctx.deps.table, Key: { pk, sk }, ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    } };
  });
  checks.push(
    closureAbsenceConditionCheck(ctx.deps, authority.actorId),
    closureAbsenceConditionCheck(ctx.deps, authority.minorId),
  );
  const combined = [...items];
  for (const item of checks) {
    const check = item.ConditionCheck!;
    const index = combined.findIndex((candidate) => {
      const operation = candidate.Put ?? candidate.Update ?? candidate.Delete ?? candidate.ConditionCheck;
      const key = operation && ('Key' in operation ? operation.Key : operation.Item);
      return operation?.TableName === check.TableName && key?.['pk'] === check.Key?.['pk'] && key?.['sk'] === check.Key?.['sk'];
    });
    if (index === -1) combined.push(item);
    else {
      const existing = combined[index].ConditionCheck;
      if (!existing) throw new ApiError('CONFLICT', 'supervision guard overlaps a mutation');
      combined[index] = { ConditionCheck: {
        ...existing,
        ConditionExpression: `(${existing.ConditionExpression}) AND (${check.ConditionExpression})`,
        ...((existing.ExpressionAttributeNames || check.ExpressionAttributeNames) ? {
          ExpressionAttributeNames: { ...existing.ExpressionAttributeNames, ...check.ExpressionAttributeNames },
        } : {}),
        ...((existing.ExpressionAttributeValues || check.ExpressionAttributeValues) ? {
          ExpressionAttributeValues: { ...existing.ExpressionAttributeValues, ...check.ExpressionAttributeValues },
        } : {}),
      } };
    }
  }
  return combined;
}
