import type { FailureCode } from '../errors/failure-code';
import type { LedgerDirection } from '../models/wallet-ledger-entry';
import type { MoneyProps } from '../models/money';
import type { WagerTransaction } from '../models/wager-transaction';

export interface IntegrationEventProps<TPayload> {
  eventId: string;
  occurredAt: Date;
  correlationId: string;
  aggregateId: string;
  payload: TPayload;
}

/** Envelope serializado que vai para o payload da outbox. */
export interface IntegrationEventJson<TPayload> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  occurredAt: string;
  version: number;
  data: TPayload;
}

export abstract class IntegrationEvent<TPayload> {
  abstract readonly eventType: string;
  abstract readonly aggregateId: string;
  readonly version: number = 1;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly payload: TPayload;

  protected constructor(props: Omit<IntegrationEventProps<TPayload>, 'aggregateId'>) {
    this.eventId = props.eventId;
    this.occurredAt = props.occurredAt;
    this.correlationId = props.correlationId;
    this.payload = props.payload;
  }

  // o payload vira "data" no JSON, como no envelope do README
  toJSON(): IntegrationEventJson<TPayload> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.payload,
    };
  }
}

/** Metadados do envelope; id e data entram de fora para o domínio continuar puro. */
export interface EventMeta {
  eventId: string;
  occurredAt: Date;
  aggregateId: string;
  correlationId: string | null;
}

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  type: string;
  walletId: string;
  playerId: string;
  roundId: string;
  money: MoneyProps;
  balanceAfter: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode | null;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string | null;
  nextRetryAt: string | null;
  expiresAt: string | null;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly aggregateId: string;

  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    this.aggregateId = props.aggregateId;
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly aggregateId: string;

  constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
    this.aggregateId = props.aggregateId;
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly aggregateId: string;

  constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
    this.aggregateId = props.aggregateId;
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly aggregateId: string;

  constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
    this.aggregateId = props.aggregateId;
  }
}

function propsFrom<T>(meta: EventMeta, payload: T): IntegrationEventProps<T> {
  return {
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    aggregateId: meta.aggregateId,
    // sem correlationId vindo de fora, o próprio evento vira a origem
    correlationId: meta.correlationId ?? meta.eventId,
    payload,
  };
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    type: tx.type,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    money: tx.amount.toProps(tx.currency),
    balanceAfter: tx.balanceAfter.toProps(tx.currency),
  };
}

export function walletBalanceChanged(meta: EventMeta, data: WalletBalanceChangedData) {
  return new WalletBalanceChanged(propsFrom(meta, data));
}

export function wagerTransactionProcessed(meta: EventMeta, tx: WagerTransaction) {
  return new WagerTransactionProcessed(propsFrom(meta, transactionData(tx)));
}

export function wagerTransactionRejected(meta: EventMeta, tx: WagerTransaction) {
  return new WagerTransactionRejected(
    propsFrom(meta, { ...transactionData(tx), failureCode: tx.failureCode }),
  );
}

export function wagerTransactionPendingReference(meta: EventMeta, tx: WagerTransaction) {
  return new WagerTransactionPendingReference(
    propsFrom(meta, {
      ...transactionData(tx),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      nextRetryAt: tx.nextRetryAt?.toISOString() ?? null,
      expiresAt: tx.expiresAt?.toISOString() ?? null,
    }),
  );
}
