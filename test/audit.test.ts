import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../lambda/commercial/audit';

const ddbMock = mockClient(DynamoDBDocumentClient);

function writer(): AuditWriter {
  return new AuditWriter({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: 'roadmap-access-audit-test',
  });
}

describe('append-only commercial audit writer', () => {
  beforeEach(() => ddbMock.reset());

  it('reuses the caller-supplied timestamp and request id deterministically for retries', async () => {
    ddbMock.on(PutCommand).resolves({});
    const audit = writer();
    const event = {
      targetKind: 'USER',
      targetId: 'target',
      timestamp: 1_723_456_789_012,
      requestId: 'request-a',
      action: 'sponsored-access.issued',
      actor: 'arn:aws:iam::123456789012:role/operator',
      subject: 'USER#target',
      details: { grantId: 'grant-123' },
    };

    const first = await audit.append(event);
    const second = await audit.append(event);

    expect(first.pk).toBe(second.pk);
    expect(first.sk).toBe(second.sk);
    expect(first).toEqual({
      pk: 'TARGET#USER#target',
      sk: 'EVENT#1723456789012#request-a',
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
    const audit = writer();

    const entry = audit.transactPut({
      targetKind: 'USER',
      targetId: 'target',
      timestamp: 1_723_456_789_012,
      requestId: 'request-c',
      action: 'sponsored-access.revoked',
      actor: 'arn:aws:iam::123456789012:role/operator',
      subject: 'USER#target',
    });

    expect(Object.keys(entry)).toEqual(['Put']);
    expect(entry).toEqual({
      Put: {
        TableName: 'roadmap-access-audit-test',
        Item: {
          pk: 'TARGET#USER#target',
          sk: 'EVENT#1723456789012#request-c',
          timestamp: 1_723_456_789_012,
          requestId: 'request-c',
          targetKind: 'USER',
          targetId: 'target',
          action: 'sponsored-access.revoked',
          actor: 'arn:aws:iam::123456789012:role/operator',
          subject: 'USER#target',
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('accepts terminal base64 padding in trusted AWS request ids', () => {
    const requestId = 'CiVhEg0EoAMEVwg=';

    const item = writer().transactPut({
      targetKind: 'ACCESS_CODE',
      targetId: 'e32ad9bb-5327-4e1d-8feb-49493b4e943a',
      timestamp: 1_723_456_789_012,
      requestId,
      action: 'access_code.redeemed',
      actor: 'USER#redeemer',
      subject: 'code-grant',
    }).Put.Item;

    expect(item.requestId).toBe(requestId);
    expect(item.sk).toBe(`EVENT#1723456789012#${requestId}`);
  });

  it('does not let event payload fields replace generated audit identity', () => {
    const audit = writer();
    const untrustedEvent = {
      targetKind: 'USER',
      targetId: 'target',
      timestamp: 1_723_456_789_012,
      requestId: 'request-d',
      action: 'sponsored-access.redeemed',
      actor: 'USER#redeemer',
      subject: 'USER#target',
      pk: 'ATTACKER#KEY',
      sk: 'OVERWRITE',
      eventId: 'chosen-id',
      occurredAt: 0,
    } as Parameters<AuditWriter['transactPut']>[0];

    const item = audit.transactPut(untrustedEvent).Put.Item;

    expect(item).toMatchObject({
      pk: 'TARGET#USER#target',
      sk: 'EVENT#1723456789012#request-d',
      timestamp: 1_723_456_789_012,
      requestId: 'request-d',
    });
  });

  it.each([
    ['empty target kind', { targetKind: '', targetId: 'target' }],
    ['lowercase target kind', { targetKind: 'user', targetId: 'target' }],
    ['separator in target kind', { targetKind: 'USER#OTHER', targetId: 'target' }],
    ['empty target id', { targetKind: 'USER', targetId: '' }],
    ['separator in target id', { targetKind: 'USER', targetId: 'target#other' }],
    ['oversized target id', { targetKind: 'USER', targetId: 'x'.repeat(129) }],
  ])('rejects %s before constructing a DynamoDB key', (_name, target) => {
    const audit = writer();
    expect(() =>
      audit.transactPut({
        ...target,
        timestamp: 1_723_456_789_012,
        requestId: 'request-e',
        action: 'commercial.audit.invalid_target',
        actor: 'SYSTEM',
        subject: 'untrusted',
      }),
    ).toThrow('audit target');
  });

  it.each([
    ['empty request id', { timestamp: 1_723_456_789_012, requestId: '' }],
    ['separator in request id', { timestamp: 1_723_456_789_012, requestId: 'request#other' }],
    ['oversized request id', { timestamp: 1_723_456_789_012, requestId: 'x'.repeat(129) }],
    ['non-integer timestamp', { timestamp: 1.5, requestId: 'request-f' }],
    ['negative timestamp', { timestamp: -1, requestId: 'request-f' }],
  ])('rejects %s before constructing a DynamoDB key', (_name, identity) => {
    const audit = writer();
    expect(() =>
      audit.transactPut({
        targetKind: 'USER',
        targetId: 'target',
        ...identity,
        action: 'commercial.audit.invalid_identity',
        actor: 'SYSTEM',
        subject: 'untrusted',
      }),
    ).toThrow('audit identity');
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
