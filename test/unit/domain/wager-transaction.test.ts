import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/domain/errors/domain-errors';
import { FailureCode } from '../../../src/domain/errors/failure-code';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from '../../../src/domain/models/wager-transaction';
import { exponentialBackoffMs } from '../../../src/domain/services/backoff';

const BRL = parseCurrency('BRL');
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:10Z');
const t2 = new Date('2026-01-01T00:01:00Z');

const base = (
  type: WagerTransactionType,
  amount = '10.00',
  referenceExternalTransactionId: string | null = null,
) => ({
  id: 'tx1',
  providerId: 'prov',
  externalTransactionId: 'ext1',
  idempotencyKey: 'idem1',
  payloadHash: 'hash',
  type,
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  currency: BRL,
  amount: Money.fromString(amount),
  referenceExternalTransactionId,
  balanceAfter: Money.fromString('90.00'),
  source: 'HTTP' as const,
  correlationId: null,
  createdAt: t0,
});

const pending = () =>
  WagerTransaction.createPendingReference({
    ...base(WagerTransactionType.REFUND, '10.00', 'ext0'),
    nextRetryAt: t1,
    expiresAt: t2,
  });

describe('WagerTransaction: validações', () => {
  test.each([
    WagerTransactionType.OPENING,
    WagerTransactionType.BET,
    WagerTransactionType.WIN,
  ])('%s exige amount positivo', (type) => {
    expect(() => WagerTransaction.createProcessed(base(type, '0.00'))).toThrow(ValidationError);
    expect(WagerTransaction.createProcessed(base(type, '0.01')).amount.toString()).toBe('0.01');
  });

  test('LOSS aceita amount zero', () => {
    const tx = WagerTransaction.createProcessed(base(WagerTransactionType.LOSS, '0.00'));
    expect(tx.amount.isZero()).toBe(true);
  });

  test.each([WagerTransactionType.REFUND, WagerTransactionType.ROLLBACK])(
    '%s exige referenceExternalTransactionId não vazio',
    (type) => {
      expect(() => WagerTransaction.createProcessed(base(type, '10.00', null))).toThrow(
        ValidationError,
      );
      expect(() => WagerTransaction.createProcessed(base(type, '10.00', ' '))).toThrow(
        ValidationError,
      );
      expect(WagerTransaction.createProcessed(base(type, '10.00', 'ext0')).isProcessed()).toBe(
        true,
      );
    },
  );

  test('createRejected guarda failureCode e já nasce resolvida', () => {
    const tx = WagerTransaction.createRejected({
      ...base(WagerTransactionType.BET),
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    expect(tx.isRejected()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.resolvedAt).toEqual(t0);
  });

  test('rehydrate rejeita REJECTED sem failureCode', () => {
    const props = {
      ...base(WagerTransactionType.BET),
      referenceTransactionId: null,
      status: WagerTransactionStatus.REJECTED,
      failureCode: null,
      resolvedAt: t0,
      nextRetryAt: null,
      expiresAt: null,
      pendingAttempts: 0,
    };
    expect(() => WagerTransaction.rehydrate(props)).toThrow(ValidationError);
  });

  test('createPendingReference nasce pendente com 0 tentativas', () => {
    const tx = pending();
    expect(tx.isPending()).toBe(true);
    expect(tx.pendingAttempts).toBe(0);
    expect(tx.resolvedAt).toBeNull();
    expect(tx.nextRetryAt).toEqual(t1);
    expect(tx.expiresAt).toEqual(t2);
  });
});

describe('WagerTransaction: transições', () => {
  test('resolveAsProcessed finaliza a transação', () => {
    const tx = pending();
    tx.resolveAsProcessed(
      { balanceAfter: Money.fromString('110.00'), referenceTransactionId: 'tx0' },
      t1,
    );
    expect(tx.isProcessed()).toBe(true);
    expect(tx.referenceTransactionId).toBe('tx0');
    expect(tx.balanceAfter.toString()).toBe('110.00');
    expect(tx.resolvedAt).toEqual(t1);
    expect(tx.nextRetryAt).toBeNull();
  });

  test('resolveAsRejected finaliza com failureCode', () => {
    const tx = pending();
    tx.resolveAsRejected(
      { failureCode: FailureCode.REFERENCE_NOT_FOUND, balanceAfter: Money.fromString('90.00') },
      t1,
    );
    expect(tx.isRejected()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(tx.resolvedAt).toEqual(t1);
  });

  test('scheduleRetry incrementa pendingAttempts e atualiza nextRetryAt', () => {
    const tx = pending();
    tx.scheduleRetry(t2, t1);
    tx.scheduleRetry(t2, t1);
    expect(tx.pendingAttempts).toBe(2);
    expect(tx.nextRetryAt).toEqual(t2);
    expect(tx.isPending()).toBe(true);
  });

  test('scheduleRetry rejeita nextRetryAt no passado', () => {
    expect(() => pending().scheduleRetry(t0, t1)).toThrow(ValidationError);
  });

  test('estados terminais são imutáveis', () => {
    const processed = WagerTransaction.createProcessed(base(WagerTransactionType.BET));
    const rejected = WagerTransaction.createRejected({
      ...base(WagerTransactionType.BET),
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    for (const tx of [processed, rejected]) {
      expect(() =>
        tx.resolveAsProcessed({ balanceAfter: Money.zero(), referenceTransactionId: 'x' }, t1),
      ).toThrow(ValidationError);
      expect(() =>
        tx.resolveAsRejected(
          { failureCode: FailureCode.AMOUNT_MISMATCH, balanceAfter: Money.zero() },
          t1,
        ),
      ).toThrow(ValidationError);
      expect(() => tx.scheduleRetry(t2, t1)).toThrow(ValidationError);
    }
  });
});

describe('exponentialBackoffMs', () => {
  test('cresce exponencialmente e respeita o teto', () => {
    expect(exponentialBackoffMs(0, 100, 1000)).toBe(100);
    expect(exponentialBackoffMs(1, 100, 1000)).toBe(200);
    expect(exponentialBackoffMs(3, 100, 1000)).toBe(800);
    expect(exponentialBackoffMs(4, 100, 1000)).toBe(1000);
    expect(exponentialBackoffMs(-3, 100, 1000)).toBe(100);
  });
});

