import { describe, expect, test } from 'bun:test';
import {
  InsufficientFundsError,
  NegativeBalanceOnReversalError,
  ValidationError,
} from '../../../src/domain/errors/domain-errors';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';
import { Wallet } from '../../../src/domain/models/wallet';

const BRL = parseCurrency('BRL');
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:01Z');

const openWallet = (balance = '100.00') =>
  Wallet.open({
    id: 'w1',
    playerId: 'p1',
    currency: BRL,
    initialBalance: Money.fromString(balance),
    now: t0,
  });

describe('Wallet', () => {
  test('open inicia com version 1, mesmo com saldo inicial > 0', () => {
    const wallet = openWallet('50.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.createdAt).toEqual(t0);
    expect(wallet.updatedAt).toEqual(t0);
  });

  test('open rejeita playerId vazio', () => {
    expect(() =>
      Wallet.open({
        id: 'w1',
        playerId: '  ',
        currency: BRL,
        initialBalance: Money.zero(),
        now: t0,
      }),
    ).toThrow(ValidationError);
  });

  test('rehydrate valida version >= 1', () => {
    const base = {
      id: 'w1',
      playerId: 'p1',
      currency: BRL,
      balance: Money.zero(),
      createdAt: t0,
      updatedAt: t0,
    };
    expect(() => Wallet.rehydrate({ ...base, version: 0 })).toThrow(ValidationError);
    expect(Wallet.rehydrate({ ...base, version: 7 }).version).toBe(7);
  });

  test('credit soma saldo, incrementa version e atualiza updatedAt', () => {
    const wallet = openWallet();
    wallet.credit(Money.fromString('25.50'), t1);
    expect(wallet.balance.toString()).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
  });

  test('debit subtrai saldo, incrementa version e atualiza updatedAt', () => {
    const wallet = openWallet();
    wallet.debit(Money.fromString('100.00'), t1);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
  });

  test('debit sem saldo lança InsufficientFundsError e não altera estado', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debit(Money.fromString('10.01'), t1)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('debitForReversal sem saldo lança NegativeBalanceOnReversalError', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debitForReversal(Money.fromString('10.01'), t1)).toThrow(
      NegativeBalanceOnReversalError,
    );
    wallet.debitForReversal(Money.fromString('10.00'), t1);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(2);
  });

  test('canDebit compara saldo com o valor', () => {
    const wallet = openWallet('10.00');
    expect(wallet.canDebit(Money.fromString('10.00'))).toBe(true);
    expect(wallet.canDebit(Money.fromString('10.01'))).toBe(false);
  });

  test('mutações exigem amount positivo', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(Money.zero(), t1)).toThrow(ValidationError);
    expect(() => wallet.debit(Money.zero(), t1)).toThrow(ValidationError);
    expect(() => wallet.debitForReversal(Money.zero(), t1)).toThrow(ValidationError);
    expect(wallet.version).toBe(1);
  });
});

