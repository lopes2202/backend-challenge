import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/domain/errors/domain-errors';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/models/wallet-ledger-entry';

const BRL = parseCurrency('BRL');

const params = (
  direction: LedgerDirection,
  amount: string,
  before: string,
  after: string,
) => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  entryType: 'BET',
  direction,
  amount: Money.fromString(amount),
  currency: BRL,
  balanceBefore: Money.fromString(before),
  balanceAfter: Money.fromString(after),
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

describe('WalletLedgerEntry', () => {
  test('CREDIT válido: before + amount == after; sequence nula na criação', () => {
    const entry = WalletLedgerEntry.create(params(LedgerDirection.CREDIT, '10.00', '5.00', '15.00'));
    expect(entry.sequence).toBeNull();
    expect(entry.money).toEqual({ amount: '10.00', currency: BRL });
  });

  test('DEBIT válido: before - amount == after', () => {
    const entry = WalletLedgerEntry.create(params(LedgerDirection.DEBIT, '10.00', '15.00', '5.00'));
    expect(entry.balanceAfter.toString()).toBe('5.00');
  });

  test('rejeita amount zero', () => {
    expect(() =>
      WalletLedgerEntry.create(params(LedgerDirection.CREDIT, '0.00', '5.00', '5.00')),
    ).toThrow(ValidationError);
  });

  test('rejeita equação inconsistente em CREDIT e DEBIT', () => {
    expect(() =>
      WalletLedgerEntry.create(params(LedgerDirection.CREDIT, '10.00', '5.00', '14.00')),
    ).toThrow(ValidationError);
    expect(() =>
      WalletLedgerEntry.create(params(LedgerDirection.DEBIT, '10.00', '15.00', '4.00')),
    ).toThrow(ValidationError);
  });

  test('DEBIT que resultaria em saldo negativo é rejeitado', () => {
    expect(() =>
      WalletLedgerEntry.create(params(LedgerDirection.DEBIT, '10.00', '5.00', '0.00')),
    ).toThrow(ValidationError);
  });

  test('rehydrate preenche sequence (bigint ou number) e revalida', () => {
    const base = params(LedgerDirection.CREDIT, '10.00', '5.00', '15.00');
    expect(WalletLedgerEntry.rehydrate({ ...base, sequence: 42n }).sequence).toBe(42n);
    expect(WalletLedgerEntry.rehydrate({ ...base, sequence: 7 }).sequence).toBe(7);
    expect(() =>
      WalletLedgerEntry.rehydrate({ ...base, balanceAfter: Money.fromString('1.00'), sequence: 1 }),
    ).toThrow(ValidationError);
  });

  test('é imutável em runtime', () => {
    const entry = WalletLedgerEntry.create(params(LedgerDirection.CREDIT, '10.00', '5.00', '15.00'));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { id: string }).id = 'outro';
    }).toThrow();
  });
});

