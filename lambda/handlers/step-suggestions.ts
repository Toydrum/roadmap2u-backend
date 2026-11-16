import { randomUUID } from 'node:crypto';
import { ApiError, type StepSuggestionsRequest, type StepSuggestionsResponse } from '@app/api/contracts';
import { generateStepSuggestions, isStepTitle } from '../ai/nova-step-suggestions';
import { type Ctx, closureAbsenceConditionCheck, writableProfileConditionCheck } from '../authz';
import { K, TransactWriteCommand } from '../db';
import { parseJsonBody } from '../http';
import { isOrdinaryOwnAccount, requireOwnAccountAdmission } from '../privacy/consent';

const DAILY_LIMIT = 10;
const SECONDS_PER_DAY = 86_400;
const MAX_COHORT_SIZE = 5;
const MAX_BODY_BYTES = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPilotMember(ctx: Ctx): boolean {
  if (process.env['COMMERCIAL_STAGE'] !== 'dev' || !isOrdinaryOwnAccount(ctx.caller)) return false;
  const subjects = (process.env['TASK_SUGGESTIONS_PILOT_SUBS'] ?? '').split(',');
  return subjects.length <= MAX_COHORT_SIZE && subjects.every((subject) => UUID.test(subject)) &&
    subjects.some((subject) => subject.toLowerCase() === ctx.callerId.toLowerCase());
}

export async function canUseStepSuggestions(ctx: Ctx): Promise<boolean> {
  if (!isPilotMember(ctx)) return false;
  try {
    await requireOwnAccountAdmission(ctx);
    return true;
  } catch {
    return false;
  }
}

export function parseStepSuggestionsBody(ctx: Ctx, body: string | undefined, isBase64Encoded: boolean): unknown {
  if (!isPilotMember(ctx)) throw new ApiError('FORBIDDEN');
  if (isBase64Encoded || Buffer.byteLength(body ?? '', 'utf8') > MAX_BODY_BYTES) {
    throw new ApiError('VALIDATION', 'invalid step suggestion request');
  }
  return parseJsonBody(body);
}

function isTitleList(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(isStepTitle);
}

function suggestionContext(body: unknown): StepSuggestionsRequest {
  if (!body || typeof body !== 'object' || Object.keys(body).length !== 5) {
    throw new ApiError('VALIDATION', 'invalid step suggestion request');
  }
  const { language, treeTitle, branchTitle, ancestorTitles, existingStepTitles } = body as Record<string, unknown>;
  if ((language !== 'es' && language !== 'en') || !isStepTitle(treeTitle) || !isStepTitle(branchTitle) ||
      !isTitleList(ancestorTitles, 3) || !isTitleList(existingStepTitles, 1)) {
    throw new ApiError('VALIDATION', 'invalid step suggestion request');
  }
  return {
    language,
    treeTitle: treeTitle.trim(),
    branchTitle: branchTitle.trim(),
    ancestorTitles: ancestorTitles.map((title) => title.trim()),
    existingStepTitles: existingStepTitles.map((title) => title.trim()),
  };
}

async function reserveDailyAttempt(ctx: Ctx): Promise<void> {
  const { deps, callerId } = ctx;
  const now = deps.now();
  const dayStart = Math.floor(now / (SECONDS_PER_DAY * 1_000)) * SECONDS_PER_DAY;
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const profile = writableProfileConditionCheck(deps, callerId).ConditionCheck!;
  try {
    await deps.ddb.send(new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          ConditionCheck: {
            ...profile,
            ConditionExpression: `${profile.ConditionExpression} AND accountType = :adult AND attribute_not_exists(privacyMode)`,
            ExpressionAttributeValues: { ...profile.ExpressionAttributeValues, ':adult': 'adult' },
          },
        },
        closureAbsenceConditionCheck(deps, callerId),
        {
          Update: {
            TableName: deps.table,
            Key: K.stepSuggestionsRate(callerId, utcDay),
            UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':limit': DAILY_LIMIT, ':one': 1, ':ttl': dayStart + SECONDS_PER_DAY * 2 },
          },
        },
      ],
    }));
  } catch (error) {
    const cause = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    if (cause?.name === 'TransactionCanceledException') {
      const [profileCheck, closureCheck, quotaCheck] = cause.CancellationReasons ?? [];
      if (closureCheck?.Code === 'ConditionalCheckFailed') throw new ApiError('CONFLICT');
      if (profileCheck?.Code === 'ConditionalCheckFailed') throw new ApiError('FORBIDDEN');
      if (quotaCheck?.Code === 'ConditionalCheckFailed') throw new ApiError('RATE_LIMITED');
    }
    throw new ApiError('STEP_SUGGESTIONS_UNAVAILABLE');
  }
}

export async function suggestSteps(ctx: Ctx, body: unknown): Promise<StepSuggestionsResponse> {
  const context = suggestionContext(body);
  try {
    await requireOwnAccountAdmission(ctx);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('STEP_SUGGESTIONS_UNAVAILABLE');
  }
  await reserveDailyAttempt(ctx);
  return generateStepSuggestions(context);
}
