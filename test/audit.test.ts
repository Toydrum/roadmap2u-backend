import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../lambda/commercial/audit';

const ddbMock = mockClient(DynamoDBDocumentClient);

function writerWith(ids: string[]): AuditWriter {
  return new AuditWriter({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: 'roadmap-access-audit-test',
    now: () => 1_723_456_789_012,
    nextEventId: () => {
      const id = ids.shift();
      if (!id) throw new Error('No audit event id fixture remains.');
      return id;
    },
  });
}

describe('append-only commercial audit writer', () => {
  beforeEach(() => ddbMock.reset());

  it('appends each event with unique keys and an absence condition', async () => {
    ddbMock.on(PutCommand).resolves({});
    const writer = writerWith(['event-a', 'event-b']);
    const event = {
      action: 'sponsored-access.issued',
      actor: 'arn:aws:iam::123456789012:role/operator',
      subject: 'USER#target',
      details: { grantId: 'grant-123' },
    };

    const first = await writer.append(event);
    const second = await writer.append(event);

    expect(first.pk).not.toBe(second.pk);
    expect(first.sk).not.toBe(second.sk);
    expect(first).toEqual({
      pk: 'AUDIT#event-a',
      sk: 'EVENT#1723456789012#event-a',
      eventId: 'event-a',
      occurredAt: 1_723_456_789_012,
      ...event,
    });
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input).toEqual({
      TableName: 'roadmap-access-audit-test',
      Item: first,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
  });

  it('builds a transaction entry containing only a conditional Put', () => {
    const writer = writerWith(['event-c']);

    const entry = writer.transactPut({
      action: 'sponsored-access.revoked',
      actor: 'arn:aws:iam::123456789012:role/operator',
      subject: 'USER#target',
    });

    expect(Object.keys(entry)).toEqual(['Put']);
    expect(entry).toEqual({
      Put: {
        TableName: 'roadmap-access-audit-test',
        Item: {
          pk: 'AUDIT#event-c',
          sk: 'EVENT#1723456789012#event-c',
          eventId: 'event-c',
          occurredAt: 1_723_456_789_012,
          action: 'sponsored-access.revoked',
          actor: 'arn:aws:iam::123456789012:role/operator',
          subject: 'USER#target',
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('does not let event payload fields replace generated audit identity', () => {
    const writer = writerWith(['event-d']);
    const untrustedEvent = {
      action: 'sponsored-access.redeemed',
      actor: 'USER#redeemer',
      subject: 'USER#target',
      pk: 'ATTACKER#KEY',
      sk: 'OVERWRITE',
      eventId: 'chosen-id',
      occurredAt: 0,
    } as Parameters<AuditWriter['transactPut']>[0];

    const item = writer.transactPut(untrustedEvent).Put.Item;

    expect(item).toMatchObject({
      pk: 'AUDIT#event-d',
      sk: 'EVENT#1723456789012#event-d',
      eventId: 'event-d',
      occurredAt: 1_723_456_789_012,
    });
  });

  it('contains no overwrite, update, delete, batch-write, or non-Put transaction primitive', () => {
    const source = readFileSync(join(process.cwd(), 'lambda', 'commercial', 'audit.ts'), 'utf8');
    const file = ts.createSourceFile('audit.ts', source, ts.ScriptTarget.Latest, true);
    const commandConstructors: string[] = [];
    const transactionProperties: string[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text.endsWith('Command')) commandConstructors.push(node.expression.text);
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        if (['Put', 'Update', 'Delete', 'BatchWrite'].includes(node.name.text)) {
          transactionProperties.push(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);

    expect(new Set(commandConstructors)).toEqual(new Set(['PutCommand']));
    expect(new Set(transactionProperties)).toEqual(new Set(['Put']));
  });
});
