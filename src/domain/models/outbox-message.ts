import { ValidationError } from '../errors/domain-errors';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

/** Payload restrito a valores serializáveis em JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OutboxMessageProps {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: { [key: string]: JsonValue };
  status: OutboxStatus;
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export type CreateOutboxMessageParams = Pick<
  OutboxMessageProps,
  'id' | 'eventType' | 'aggregateType' | 'aggregateId' | 'payload' | 'createdAt'
>;

/**
 * Mensagem do Outbox, gravada na mesma transação do agregado para publicação
 * assíncrona (at-least-once). Nasce PENDING, com zero tentativas.
 */
export class OutboxMessage {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: { [key: string]: JsonValue };
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextRetryAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;

  private constructor(p: OutboxMessageProps) {
    if (!Number.isInteger(p.attempts) || p.attempts < 0) {
      throw new ValidationError('attempts deve ser inteiro >= 0');
    }
    if (p.status === 'PUBLISHED' && p.publishedAt === null) {
      throw new ValidationError('Mensagem PUBLISHED exige publishedAt');
    }
    this.id = p.id;
    this.eventType = p.eventType;
    this.aggregateType = p.aggregateType;
    this.aggregateId = p.aggregateId;
    this.payload = p.payload;
    this.status = p.status;
    this.attempts = p.attempts;
    this.nextRetryAt = p.nextRetryAt;
    this.lastError = p.lastError;
    this.createdAt = p.createdAt;
    this.publishedAt = p.publishedAt;
    Object.freeze(this);
  }

  static create(params: CreateOutboxMessageParams): OutboxMessage {
    return new OutboxMessage({
      ...params,
      status: 'PENDING',
      attempts: 0,
      nextRetryAt: params.createdAt,
      lastError: null,
      publishedAt: null,
    });
  }

  /** Retorna nova instância PUBLISHED (a entidade é imutável). */
  markPublished(now: Date): OutboxMessage {
    return new OutboxMessage({
      ...this.toProps(),
      status: 'PUBLISHED',
      nextRetryAt: null,
      lastError: null,
      publishedAt: now,
    });
  }

  /**
   * Registra falha de publicação e conta a tentativa. Vira FAILED (terminal) quando não há
   * novo agendamento (`nextRetryAt === null`) ou quando `attempts` atinge `maxAttempts`;
   * caso contrário permanece PENDING para nova tentativa em `nextRetryAt`.
   */
  markFailed(error: string, nextRetryAt: Date | null, maxAttempts: number): OutboxMessage {
    const attempts = this.attempts + 1;
    const terminal = nextRetryAt === null || attempts >= maxAttempts;
    return new OutboxMessage({
      ...this.toProps(),
      status: terminal ? 'FAILED' : 'PENDING',
      attempts,
      nextRetryAt: terminal ? null : nextRetryAt,
      lastError: error,
    });
  }

  private toProps(): OutboxMessageProps {
    return {
      id: this.id,
      eventType: this.eventType,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      payload: this.payload,
      status: this.status,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      createdAt: this.createdAt,
      publishedAt: this.publishedAt,
    };
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props);
  }
}

