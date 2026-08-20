import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const ABSENT_KEY_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

export interface AuditEvent {
  readonly targetKind: string;
  readonly targetId: string;
  readonly timestamp: number;
  readonly requestId: string;
  readonly action: string;
  readonly actor: string;
  readonly subject: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditItem extends AuditEvent {
  readonly pk: string;
  readonly sk: string;
}

export interface AuditWriterOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}

export interface AuditPutInput {
  readonly TableName: string;
  readonly Item: AuditItem;
  readonly ConditionExpression: string;
}

export interface AuditTransactPut {
  readonly Put: AuditPutInput;
}

/** Writes access events once; collisions fail instead of overwriting history. */
export class AuditWriter {
  constructor(private readonly options: AuditWriterOptions) {}

  /** Builds one append-only Put that can be composed into a DynamoDB transaction. */
  transactPut(event: AuditEvent): AuditTransactPut {
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(event.targetKind)) {
      throw new Error('invalid audit target kind');
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(event.targetId) ||
      Buffer.byteLength(event.targetId, 'utf8') > 128
    ) {
      throw new Error('invalid audit target id');
    }
    if (
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp < 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(event.requestId) ||
      Buffer.byteLength(event.requestId, 'utf8') > 128
    ) {
      throw new Error('invalid audit identity');
    }
    const item: AuditItem = {
      ...event,
      pk: `TARGET#${event.targetKind}#${event.targetId}`,
      sk: `EVENT#${event.timestamp}#${event.requestId}`,
    };
    return {
      Put: {
        TableName: this.options.tableName,
        Item: item,
        ConditionExpression: ABSENT_KEY_CONDITION,
      },
    };
  }

  /** Persists one event directly and returns the exact item that was accepted. */
  async append(event: AuditEvent): Promise<AuditItem> {
    const operation = this.transactPut(event);
    await this.options.ddb.send(new PutCommand(operation.Put));
    return operation.Put.Item;
  }
}
