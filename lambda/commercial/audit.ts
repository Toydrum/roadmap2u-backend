import { randomUUID } from 'node:crypto';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const ABSENT_KEY_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

export interface AuditEvent {
  readonly action: string;
  readonly actor: string;
  readonly subject: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditItem extends AuditEvent {
  readonly pk: string;
  readonly sk: string;
  readonly eventId: string;
  readonly occurredAt: number;
}

export interface AuditWriterOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now?: () => number;
  readonly nextEventId?: () => string;
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
  private readonly now: () => number;
  private readonly nextEventId: () => string;

  constructor(private readonly options: AuditWriterOptions) {
    this.now = options.now ?? Date.now;
    this.nextEventId = options.nextEventId ?? randomUUID;
  }

  /** Builds one append-only Put that can be composed into a DynamoDB transaction. */
  transactPut(event: AuditEvent): AuditTransactPut {
    const eventId = this.nextEventId();
    const occurredAt = this.now();
    const item: AuditItem = {
      ...event,
      pk: `AUDIT#${eventId}`,
      sk: `EVENT#${occurredAt}#${eventId}`,
      eventId,
      occurredAt,
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
