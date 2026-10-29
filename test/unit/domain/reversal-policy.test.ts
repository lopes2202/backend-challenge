import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/failure-code';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';
import { LedgerDirection } from '../../../src/domain/models/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../../src/domain/models/wager-transaction';
import { evaluateReversal, type ReversalRequest } from '../../../src/domain/services/reversal-policy';

const BRL = parseCurrency('BRL');
const USD = parseCurrency('USD');
const t0 = new Date('2026-01-01T00:00:00Z');

const reference = (
  type: WagerTransactionType,
  overrides: Partial<{ providerId: string; playerId: string; walletId: string; roundId: string }> & {
    currency?: typeof BRL;
    amount?: string;
  } = {},
) =>
  WagerTransaction.createProcessed({
    id: 'ref1',
    providerId: overrides.providerId ?? 'prov',
    externalTransactionId: 'ext-ref',
    idempotencyKey: 'k-ref',
    payloadHash: 'h',
    type,
    walletId: overrides.walletId ?? 'w1',
    playerId: overrides.playerId ?? 'p1',
    roundId: overrides.roundId ?? 'r1',
    gameId: 'g1',
    currency: overrides.currency ?? BRL,
    amount: Money.fromString(overrides.amount ?? '10.00'),
    // REFUND exige referência própria; para os demais tipos é ignorada.
    referenceExternalTransactionId: type === WagerTransactionType.REFUND ? 'ext-bet' : null,
    balanceAfter: Money.fromString('100.00'),
    source: 'HTTP',
    correlationId: null,
    createdAt: t0,
  });

const request = (type: ReversalRequest['type']): ReversalRequest => ({
  type,
  providerId: 'prov',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  currency: BRL,
  amount: Money.fromString('10.00'),
});

const REFUND = WagerTransactionType.REFUND;
const ROLLBACK = WagerTransactionType.ROLLBACK;
const BET = WagerTransactionType.BET;

describe('evaluateReversal', () => {
  test.each([REFUND, ROLLBACK] as const)('%s sem referência: NOT_YET_AVAILABLE', (type) => {
    expect(evaluateReversal(request(type), null, false)).toEqual({ outcome: 'NOT_YET_AVAILABLE' });
  });

  test.each([REFUND, ROLLBACK] as const)('%s com referência pendente: NOT_YET_AVAILABLE', (type) => {
    const pendingRef = WagerTransaction.createPendingReference({
      id: 'ref1',
      providerId: 'prov',
      externalTransactionId: 'ext-ref',
      idempotencyKey: 'k',
      payloadHash: 'h',
      type: ROLLBACK,
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      gameId: 'g1',
      currency: BRL,
      amount: Money.fromString('10.00'),
      referenceExternalTransactionId: 'x',
      balanceAfter: Money.zero(),
      source: 'SQS',
      correlationId: null,
      createdAt: t0,
      nextRetryAt: t0,
      expiresAt: t0,
    });
    expect(evaluateReversal(request(type), pendingRef, false)).toEqual({
      outcome: 'NOT_YET_AVAILABLE',
    });
  });

  test('referência rejeitada: REFERENCE_NOT_FOUND', () => {
    const rejected = WagerTransaction.createRejected({
      id: 'ref1',
      providerId: 'prov',
      externalTransactionId: 'ext-ref',
      idempotencyKey: 'k',
      payloadHash: 'h',
      type: BET,
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      gameId: 'g1',
      currency: BRL,
      amount: Money.fromString('10.00'),
      referenceExternalTransactionId: null,
      balanceAfter: Money.zero(),
      source: 'HTTP',
      correlationId: null,
      createdAt: t0,
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    expect(evaluateReversal(request(REFUND), rejected, false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.REFERENCE_NOT_FOUND,
    });
  });

  test.each([
    { providerId: 'outro' },
    { playerId: 'outro' },
    { walletId: 'outro' },
    { roundId: 'outro' },
  ])('divergência de escopo %o: REFERENCE_NOT_FOUND', (override) => {
    expect(evaluateReversal(request(REFUND), reference(BET, override), false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.REFERENCE_NOT_FOUND,
    });
  });

  test('REFUND só reverte BET', () => {
    for (const type of [WagerTransactionType.WIN, WagerTransactionType.LOSS, REFUND]) {
      expect(evaluateReversal(request(REFUND), reference(type), false)).toEqual({
        outcome: 'REJECT',
        failureCode: FailureCode.INVALID_REFERENCE_KIND,
      });
    }
  });

  test('ROLLBACK não reverte LOSS, OPENING nem ROLLBACK', () => {
    for (const type of [
      WagerTransactionType.LOSS,
      WagerTransactionType.OPENING,
      WagerTransactionType.ROLLBACK,
    ]) {
      const ref =
        type === WagerTransactionType.ROLLBACK
          ? WagerTransaction.createProcessed({
              ...baseOf(reference(BET)),
              type,
              referenceExternalTransactionId: 'ext-bet',
            })
          : reference(type, type === WagerTransactionType.LOSS ? { amount: '10.00' } : {});
      expect(evaluateReversal(request(ROLLBACK), ref, false)).toEqual({
        outcome: 'REJECT',
        failureCode: FailureCode.INVALID_REFERENCE_KIND,
      });
    }
  });

  test('moeda divergente: CURRENCY_MISMATCH', () => {
    expect(evaluateReversal(request(REFUND), reference(BET, { currency: USD }), false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.CURRENCY_MISMATCH,
    });
  });

  test('valor divergente: AMOUNT_MISMATCH', () => {
    expect(evaluateReversal(request(REFUND), reference(BET, { amount: '10.01' }), false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.AMOUNT_MISMATCH,
    });
  });

  test('já revertida: REFERENCE_ALREADY_REVERSED', () => {
    expect(evaluateReversal(request(ROLLBACK), reference(BET), true)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    });
  });

  test('REFUND de BET: OK com CREDIT', () => {
    const ref = reference(BET);
    expect(evaluateReversal(request(REFUND), ref, false)).toEqual({
      outcome: 'OK',
      direction: LedgerDirection.CREDIT,
      reference: ref,
    });
  });

  test('ROLLBACK de BET: OK com CREDIT', () => {
    const result = evaluateReversal(request(ROLLBACK), reference(BET), false);
    expect(result).toMatchObject({ outcome: 'OK', direction: LedgerDirection.CREDIT });
  });

  test('ROLLBACK de WIN e de REFUND: OK com DEBIT', () => {
    for (const type of [WagerTransactionType.WIN, REFUND]) {
      const result = evaluateReversal(request(ROLLBACK), reference(type), false);
      expect(result).toMatchObject({ outcome: 'OK', direction: LedgerDirection.DEBIT });
    }
  });
});

/** Extrai os campos de criação de uma transação existente, para derivar variações nos testes. */
function baseOf(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    type: tx.type,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    currency: tx.currency,
    amount: tx.amount,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    balanceAfter: tx.balanceAfter,
    source: tx.source,
    correlationId: tx.correlationId,
    createdAt: tx.createdAt,
  };
}

