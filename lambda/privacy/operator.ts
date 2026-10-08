import { createHash } from 'node:crypto';
import { ApiError } from '@app/api/contracts';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GetItemCommandInput } from '@aws-sdk/client-dynamodb';
import { USERNAME_PATTERN } from '@app/auth/auth-types';
import type { Deps } from '../db';
import {
  verifyPrivateAdolescentRepresentation,
  type RepresentationVerificationCommand,
} from './adolescents';
import { assertPrivateOperator, changePrivacyHold, type PrivacyHoldCommand } from './retention';
import { requestPrivateAdolescentClosure, type PrivateClosureCommand } from './private-closure';

export const PRIVACY_OPERATOR_ACCOUNT = '765932874577';
export const PRIVACY_OPERATOR_READ_ATTRIBUTES = [
  'pk',
  'sk',
  'userId',
  'username',
  'accountType',
  'status',
  'createdAt',
  'privacyMode',
  'revision',
  'updatedAt',
  'adultDeclaredAt',
  'declarationLanguage',
  'declarationDocumentHash',
  'cloudConsent',
  'cloudLanguage',
  'cloudDocumentHash',
  'erasure',
  'erasureId',
  'erasureRequestedAt',
  'erasureCompletedAt',
  'gsi2pk',
  'gsi2sk',
  'subjectKind',
  'adolescentAcceptedAt',
  'adolescentLanguage',
  'adolescentDocumentHash',
  'guardianId',
  'guardianConsent',
  'guardianAuthorization',
  'guardianLanguage',
  'guardianDocumentHash',
  'majorityAt',
  'invitationId',
  'closureId',
  'kind',
  'state',
  'actorSub',
  'requestHash',
] as const;
type OperatorCommand =
  | { action: 'verify_representation'; command: RepresentationVerificationCommand }
  | { action: 'hold'; command: PrivacyHoldCommand }
  | { action: 'request_private_closure'; command: PrivateClosureCommand };
export type PrivacyOperatorPlan = OperatorCommand & {
  stage: 'dev' | 'test' | 'prod';
  accountId: string;
  table: string;
  privacyTable: string;
  roleArn: string;
  hash: string;
};
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ApiError('VALIDATION');
}
/** Offline preview: does not load AWS credentials or contact any service. */
export function buildPrivacyOperatorPlan(stage: string, body: unknown): PrivacyOperatorPlan {
  if (
    !['dev', 'test', 'prod'].includes(stage) ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  )
    throw new ApiError('VALIDATION');
  const request = body as Record<string, unknown>;
  exactKeys(request, ['action', 'command']);
  if (
    !request['command'] ||
    typeof request['command'] !== 'object' ||
    Array.isArray(request['command'])
  )
    throw new ApiError('VALIDATION');
  const command = request['command'] as Record<string, unknown>;
  if (
    typeof command['commandId'] !== 'string' ||
    !SAFE.test(command['commandId']) ||
    typeof command['caseId'] !== 'string' ||
    !SAFE.test(command['caseId']) ||
    !Number.isSafeInteger(command['expectedRevision']) ||
    (command['expectedRevision'] as number) < 0 ||
    (command['expectedRevision'] as number) >= Number.MAX_SAFE_INTEGER
  )
    throw new ApiError('VALIDATION');
  if (request['action'] === 'verify_representation') {
    exactKeys(command, [
      'invitationId',
      'commandId',
      'caseId',
      'expectedRevision',
      'guardianId',
      'recipientUsername',
      'majorityAt',
    ]);
    if (
      !['invitationId', 'guardianId', 'recipientUsername', 'majorityAt'].every(
        (name) => typeof command[name] === 'string',
      ) ||
      !/^[a-f0-9]{64}$/.test(command['invitationId'] as string) ||
      !SAFE.test(command['guardianId'] as string) ||
      !USERNAME_PATTERN.test(command['recipientUsername'] as string) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(command['majorityAt'] as string) ||
      (command['expectedRevision'] as number) < 1
    )
      throw new ApiError('VALIDATION');
  } else if (request['action'] === 'request_private_closure') {
    exactKeys(command, [
      'userId',
      'username',
      'guardianId',
      'invitationId',
      'expectedRevision',
      'commandId',
      'caseId',
    ]);
    if (
      typeof command['invitationId'] !== 'string' ||
      !['userId', 'username', 'guardianId'].every(
        (name) => typeof command[name] === 'string' && SAFE.test(command[name] as string),
      ) ||
      !/^[a-f0-9]{64}$/.test(command['invitationId'] as string) ||
      (command['expectedRevision'] as number) < 1
    )
      throw new ApiError('VALIDATION');
  } else if (
    request['action'] === 'hold' &&
    ['set', 'release'].includes(command['action'] as string)
  ) {
    exactKeys(command, [
      'action',
      'userId',
      'caseId',
      'commandId',
      'expectedRevision',
      ...(command['action'] === 'set' ? ['scope', 'legalBasis', 'expiresAt', 'reviewAt'] : []),
    ]);
    if (
      typeof command['userId'] !== 'string' ||
      !SAFE.test(command['userId']) ||
      (command['action'] === 'set' &&
        (!['forest', 'account', 'consent', 'audit', 'commercial'].includes(
          command['scope'] as string,
        ) ||
          typeof command['legalBasis'] !== 'string' ||
          !command['legalBasis'].trim() ||
          command['legalBasis'].length > 2000 ||
          !Number.isSafeInteger(command['expiresAt']) ||
          !Number.isSafeInteger(command['reviewAt']) ||
          (command['reviewAt'] as number) > (command['expiresAt'] as number)))
    )
      throw new ApiError('VALIDATION');
  } else throw new ApiError('VALIDATION');
  const core = {
    stage: stage as PrivacyOperatorPlan['stage'],
    accountId: PRIVACY_OPERATOR_ACCOUNT,
    table: `roadmap-${stage}`,
    privacyTable: `roadmap-privacy-${stage}`,
    roleArn: `arn:aws:iam::${PRIVACY_OPERATOR_ACCOUNT}:role/roadmap2u/${stage}/operators/roadmap2u-${stage}-privacy-operator`,
    ...(request as OperatorCommand),
  };
  // Stable key order also makes a plan reproducible when JSON file keys move.
  const canonical = JSON.stringify(core, Object.keys(core).concat(Object.keys(command)).sort());
  return { ...core, hash: createHash('sha256').update(canonical).digest('hex') };
}
export function confirmPrivacyOperatorPlan(
  plan: PrivacyOperatorPlan,
  stage?: string,
  hash?: string,
) {
  if (stage !== plan.stage || hash !== plan.hash) throw new ApiError('VALIDATION');
}
/** IAM denies full-item reads. The operator requests only metadata, never REC content. */
export function constrainPrivacyOperatorReads(client: DynamoDBDocumentClient, table: string) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const input = args.input as GetItemCommandInput;
      if (context.commandName === 'GetItemCommand' && input.TableName === table) {
        input.ExpressionAttributeNames = Object.fromEntries(
          PRIVACY_OPERATOR_READ_ATTRIBUTES.map((name, index) => [`#meta${index}`, name]),
        );
        input.ProjectionExpression = PRIVACY_OPERATOR_READ_ATTRIBUTES.map(
          (_, index) => `#meta${index}`,
        ).join(', ');
      }
      return next(args);
    },
    { step: 'initialize', name: 'privacyMetadataReads', priority: 'high' },
  );
}
export async function executePrivacyOperatorPlan(
  plan: PrivacyOperatorPlan,
  deps: Deps,
  identity: { Account?: string; Arn?: string },
) {
  if (
    deps.table !== plan.table ||
    deps.privacyTable !== plan.privacyTable ||
    identity.Account !== plan.accountId ||
    !identity.Arn
  )
    throw new ApiError('FORBIDDEN');
  const operator = { arn: identity.Arn, roleArn: plan.roleArn };
  assertPrivateOperator(operator);
  if (plan.action === 'verify_representation')
    await verifyPrivateAdolescentRepresentation(deps, plan.command, operator);
  else if (plan.action === 'hold') await changePrivacyHold(deps, plan.command, operator);
  else await requestPrivateAdolescentClosure(deps, plan.command, operator);
}
