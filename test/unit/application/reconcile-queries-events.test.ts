import { describe, expect, test } from 'bun:test';
import { ReconcileWalletUseCase } from '../../../src/application/use-cases/reconcile-wallet.use-case';
import type {
  LoggerPort,
  MetricsPort,
  TransactionalContext,
  UnitOfWorkPort,
} from '../../../src/application/ports';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';
import { Wallet } from '../../../src/domain/models/wallet';
import { LedgerDirection } from '../../../src/domain/models/wallet-ledger-entry';
import { walletBalanceChanged } from '../../../src/domain/events/wager-events';
import { TransactionNotFoundError } from '../../../src/domain/errors/domain-errors';
import { QueriesUseCase } from '../../../src/application/use-cases/queries.use-case';

const BRL = parseCurrency('BRL');
const now = new Date('2026-01-01T00:00:00Z');

function uowWith(ctx: Partial<TransactionalContext>): UnitOfWorkPort {
  const full = ctx as TransactionalContext;
  return { run: (work) => work(full), runReadOnlyRepeatableRead: (work) => work(full) };
}

function spies() {
  const errors: { msg: string; meta?: Record<string, unknown> }[] = [];
  const counters: { name: string; value?: number; tags?: Record<string, string> }[] = [];
  const logger: LoggerPort = {
    info: () => {},
    warn: () => {},
    error: (msg, meta) => void errors.push(meta ? { msg, meta } : { msg }),
  };
  const metrics: MetricsPort = {
    increment: (name, value, tags) =>
      void counters.push({ name, ...(value !== undefined && { value }), ...(tags && { tags }) }),
    observe: () => {},
  };
  return { logger, metrics, errors, counters };
}

const wallet = () =>
  Wallet.open({ id: 'w1', playerId: 'p1', currency: BRL, initialBalance: Money.fromString('100.00'), now });

const reconcileWith = (net: string) => {
  const s = spies();
  const useCase = new ReconcileWalletUseCase({
    uow: uowWith({
      wallets: { findById: async () => wallet() } as unknown as TransactionalContext['wallets'],
      ledger: {
        reconcileBalance: async () => ({ netBalance: Money.fromString(net), entriesCount: 3 }),
      } as unknown as TransactionalContext['ledger'],
    }),
    clock: { now: () => now },
    logger: s.logger,
    metrics: s.metrics,
  });
  return { useCase, ...s };
};

describe('ReconcileWalletUseCase', () => {
  test('saldo consistente não loga nem conta divergência', async () => {
    const { useCase, errors, counters } = reconcileWith('100.00');
    const view = await useCase.execute('w1');
    expect(view.consistent).toBe(true);
    expect(view.difference.amount).toBe('0.00');
    expect(errors).toHaveLength(0);
    expect(counters).toHaveLength(0);
  });

  test('divergência é logada, contada e sinalizada na resposta', async () => {
    const { useCase, errors, counters } = reconcileWith('90.00');
    const view = await useCase.execute('w1');
    expect(view.consistent).toBe(false);
    expect(view.difference.amount).toBe('10.00');
    expect(errors[0]?.msg).toBe('Wallet reconciliation divergence detected');
    expect(counters).toEqual([
      { name: 'wallet.reconciliation.divergence', value: 1, tags: { walletId: 'w1' } },
    ]);
  });
});

describe('QueriesUseCase', () => {
  test('transação inexistente lança TransactionNotFoundError', async () => {
    const queries = new QueriesUseCase({
      uow: uowWith({
        transactions: {
          findById: async () => null,
          findByProviderAndExternalId: async () => null,
        } as unknown as TransactionalContext['transactions'],
      }),
    });
    await expect(queries.getTransaction('x')).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(queries.getTransactionByProvider('p', 'e')).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
  });
});

describe('IntegrationEvent', () => {
  test('toJSON devolve o envelope com version 1 e payload como data', () => {
    const money = Money.fromString('10.00').toProps(BRL);
    const event = walletBalanceChanged(
      { eventId: 'e1', occurredAt: now, aggregateId: 'w1', correlationId: null },
      {
        walletId: 'w1',
        playerId: 'p1',
        transactionId: 't1',
        direction: LedgerDirection.CREDIT,
        money,
        balanceBefore: Money.zero().toProps(BRL),
        balanceAfter: money,
        walletVersion: 2,
      },
    );
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    const json = event.toJSON();
    expect(json).toMatchObject({
      eventId: 'e1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w1',
      correlationId: 'e1',
      occurredAt: now.toISOString(),
      version: 1,
    });
    expect(json.data.walletVersion).toBe(2);
  });
});

