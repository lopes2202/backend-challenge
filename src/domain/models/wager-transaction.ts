import { FailureCode } from '../errors/failure-code';
import { ValidationError } from '../errors/domain-errors';
import type { Currency } from './currency';
import type { Money } from './money';

export enum WagerTransactionType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
}

export type TransactionSource = 'HTTP' | 'SQS' | 'SYSTEM';

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  type: WagerTransactionType;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  currency: Currency;
  amount: Money;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: Money;
  source: TransactionSource;
  correlationId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  nextRetryAt: Date | null;
  expiresAt: Date | null;
  pendingAttempts: number;
}

type NewTransactionParams = Omit<
  WagerTransactionProps,
  | 'status'
  | 'failureCode'
  | 'resolvedAt'
  | 'nextRetryAt'
  | 'expiresAt'
  | 'pendingAttempts'
  | 'referenceTransactionId'
> & { referenceTransactionId?: string | null };

/**
 * Registro de uma transação de aposta recebida de um provedor.
 *
 * Invariantes:
 * - BET/WIN/REFUND/ROLLBACK/OPENING têm amount > 0; LOSS aceita amount >= 0 (não move saldo).
 * - REFUND e ROLLBACK exigem `referenceExternalTransactionId`.
 * - PROCESSED e REJECTED são estados terminais e imutáveis; só PENDING_REFERENCE transiciona.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly type: WagerTransactionType;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly currency: Currency;
  readonly amount: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly source: TransactionSource;
  readonly correlationId: string | null;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _failureCode: FailureCode | null;
  private _referenceTransactionId: string | null;
  private _balanceAfter: Money;
  private _resolvedAt: Date | null;
  private _nextRetryAt: Date | null;
  private _expiresAt: Date | null;
  private _pendingAttempts: number;

  private constructor(p: WagerTransactionProps) {
    WagerTransaction.assertInvariants(p);
    this.id = p.id;
    this.providerId = p.providerId;
    this.externalTransactionId = p.externalTransactionId;
    this.idempotencyKey = p.idempotencyKey;
    this.payloadHash = p.payloadHash;
    this.type = p.type;
    this.walletId = p.walletId;
    this.playerId = p.playerId;
    this.roundId = p.roundId;
    this.gameId = p.gameId;
    this.currency = p.currency;
    this.amount = p.amount;
    this.referenceExternalTransactionId = p.referenceExternalTransactionId;
    this.source = p.source;
    this.correlationId = p.correlationId;
    this.createdAt = p.createdAt;
    this._status = p.status;
    this._failureCode = p.failureCode;
    this._referenceTransactionId = p.referenceTransactionId;
    this._balanceAfter = p.balanceAfter;
    this._resolvedAt = p.resolvedAt;
    this._nextRetryAt = p.nextRetryAt;
    this._expiresAt = p.expiresAt;
    this._pendingAttempts = p.pendingAttempts;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get failureCode(): FailureCode | null {
    return this._failureCode;
  }
  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }
  get balanceAfter(): Money {
    return this._balanceAfter;
  }
  get resolvedAt(): Date | null {
    return this._resolvedAt;
  }
  get nextRetryAt(): Date | null {
    return this._nextRetryAt;
  }
  get expiresAt(): Date | null {
    return this._expiresAt;
  }
  get pendingAttempts(): number {
    return this._pendingAttempts;
  }

  /** Transação aplicada com sucesso; já nasce resolvida. */
  static createProcessed(params: NewTransactionParams): WagerTransaction {
    return new WagerTransaction({
      ...params,
      referenceTransactionId: params.referenceTransactionId ?? null,
      status: WagerTransactionStatus.PROCESSED,
      failureCode: null,
      resolvedAt: params.createdAt,
      nextRetryAt: null,
      expiresAt: null,
      pendingAttempts: 0,
    });
  }

  /** Transação rejeitada por regra de negócio; estado terminal. */
  static createRejected(
    params: NewTransactionParams & { failureCode: FailureCode },
  ): WagerTransaction {
    return new WagerTransaction({
      ...params,
      referenceTransactionId: params.referenceTransactionId ?? null,
      status: WagerTransactionStatus.REJECTED,
      resolvedAt: params.createdAt,
      nextRetryAt: null,
      expiresAt: null,
      pendingAttempts: 0,
    });
  }

  /** Reversão cuja referência ainda não chegou; será reprocessada até `expiresAt`. */
  static createPendingReference(
    params: NewTransactionParams & { nextRetryAt: Date; expiresAt: Date },
  ): WagerTransaction {
    return new WagerTransaction({
      ...params,
      referenceTransactionId: params.referenceTransactionId ?? null,
      status: WagerTransactionStatus.PENDING_REFERENCE,
      failureCode: null,
      resolvedAt: null,
      pendingAttempts: 0,
    });
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }

  isPending(): boolean {
    return this._status === WagerTransactionStatus.PENDING_REFERENCE;
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.PROCESSED;
  }

  isRejected(): boolean {
    return this._status === WagerTransactionStatus.REJECTED;
  }

  resolveAsProcessed(
    params: { balanceAfter: Money; referenceTransactionId: string },
    now: Date,
  ): void {
    this.assertPending();
    this._status = WagerTransactionStatus.PROCESSED;
    this._failureCode = null;
    this._balanceAfter = params.balanceAfter;
    this._referenceTransactionId = params.referenceTransactionId;
    this.finishResolution(now);
  }

  resolveAsRejected(params: { failureCode: FailureCode; balanceAfter: Money }, now: Date): void {
    this.assertPending();
    this._status = WagerTransactionStatus.REJECTED;
    this._failureCode = params.failureCode;
    this._balanceAfter = params.balanceAfter;
    this.finishResolution(now);
  }

  /** Agenda nova tentativa; incrementa `pendingAttempts`. */
  scheduleRetry(nextRetryAt: Date, now: Date): void {
    this.assertPending();
    if (nextRetryAt.getTime() < now.getTime()) {
      throw new ValidationError('nextRetryAt não pode ser anterior ao instante atual');
    }
    this._nextRetryAt = nextRetryAt;
    this._pendingAttempts += 1;
  }

  private finishResolution(now: Date): void {
    this._resolvedAt = now;
    this._nextRetryAt = null;
    this._expiresAt = null;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new ValidationError(
        `Transação em estado terminal (${this._status}) não pode ser alterada`,
      );
    }
  }

  private static assertInvariants(p: WagerTransactionProps): void {
    // LOSS não altera saldo: aceita amount >= 0 (já garantido por Money). Demais tipos exigem > 0.
    if (p.type !== WagerTransactionType.LOSS && !p.amount.isPositive()) {
      throw new ValidationError(`Transação ${p.type} exige amount estritamente positivo`);
    }
    const needsReference =
      p.type === WagerTransactionType.REFUND || p.type === WagerTransactionType.ROLLBACK;
    if (needsReference && (p.referenceExternalTransactionId ?? '').trim() === '') {
      throw new ValidationError(`Transação ${p.type} exige referenceExternalTransactionId`);
    }
    if (p.status === WagerTransactionStatus.REJECTED && p.failureCode === null) {
      throw new ValidationError('Transação REJECTED exige failureCode');
    }
    if (p.status !== WagerTransactionStatus.REJECTED && p.failureCode !== null) {
      throw new ValidationError('failureCode só é permitido em transação REJECTED');
    }
    if (!Number.isInteger(p.pendingAttempts) || p.pendingAttempts < 0) {
      throw new ValidationError('pendingAttempts deve ser inteiro >= 0');
    }
  }
}

