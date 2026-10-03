import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { PaidAccessSources } from './access-resolver';

const COMMON_ATTRIBUTES = [
  'pk',
  'sk',
  'entityType',
  'state',
  'paidThrough',
  'graceUntil',
  'revision',
  'updatedAt',
] as const;
export const SUBSCRIPTION_SOURCE_ATTRIBUTES = [
  ...COMMON_ATTRIBUTES,
  'ownerSub',
  'sourceId',
] as const;
export const COVERAGE_SOURCE_ATTRIBUTES = [
  ...COMMON_ATTRIBUTES,
  'accountId',
  'householdId',
  'seatType',
  'source',
] as const;

/** Fence both presence and absence; a coverage writer need not update ACCESS. */
export function paidSourceGuards(
  tableName: string,
  ownerSub: string,
  sources: PaidAccessSources,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return [
    {
      sk: 'SUBSCRIPTION#INDIVIDUAL',
      item: sources.subscription,
      attributes: SUBSCRIPTION_SOURCE_ATTRIBUTES,
    },
    { sk: 'COVERAGE#FAMILY', item: sources.coverage, attributes: COVERAGE_SOURCE_ATTRIBUTES },
  ].map(({ sk, item, attributes }) => {
    const base = { TableName: tableName, Key: { pk: `USER#${ownerSub}`, sk } };
    if (!item)
      return {
        ConditionCheck: {
          ...base,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      };
    const record = item as unknown as Record<string, unknown>;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const conditions = attributes.map((attribute) => {
      names[`#${attribute}`] = attribute;
      if (record[attribute] === undefined) return `attribute_not_exists(#${attribute})`;
      values[`:${attribute}`] = record[attribute];
      return `#${attribute} = :${attribute}`;
    });
    return {
      ConditionCheck: {
        ...base,
        ConditionExpression: `attribute_exists(pk) AND attribute_exists(sk) AND ${conditions.join(' AND ')}`,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      },
    };
  });
}
