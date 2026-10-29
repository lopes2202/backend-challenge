import {
  WalletAlreadyExistsError,
} from '../../domain/errors/domain-errors';
import {
  walletBalanceChanged,
  wagerTransactionProcessed,
  type EventMeta,
} from '../../domain/events/wager-events';
import type { Currency } from '../../domain/models/currency';
import { Money } from '../../domain/models/money';
import { Wallet } from '../../domain/models/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/models/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionType } from '../../domain/models/wager-transaction';
import { toWalletView, type WalletView } from '../dto/views';
import {
  parseMoneyInput,
  requireObject,
  requireString,
} from '../dto/wager-transaction-command';
import {
  UniqueConstraintViolationError,
  type ClockPort,
  type IdGeneratorPort,
  type UnitOfWorkPort,
} from '../ports';
import { canonicalJsonHash } from '../utils/canonical-json-hash';
import { enqueueEvent } from '../utils/outbox-events';

export interface CreateWalletCommand {
  playerId: string;
  currency: Currency;
  initialBalance: Money;
}

/** Valida `{ playerId, initialBalance: { amount, currency } }`. */
export function parseCreateWalletCommand(body: unknown): CreateWalletCommand {
  const raw = requireObject(body, 'body');
  const playerId = requireString(raw, 'playerId');
  const { amount, currency } = parseMoneyInput(raw['initialBalance'], 'initialBalance');
  return { playerId, currency, initialBalance: amount };
}

export interface CreateWalletDeps {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
}

export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDeps) {}

  /**
   * Fluxo transacional único (`uow.run`): unicidade (playerId, currency) -> insert da carteira
   * (version = 1) -> se saldo inicial > 0, transação OPENING + lançamento CREDIT + eventos no
   * Outbox, tudo no mesmo commit. A corrida entre duas criações concorrentes é resolvida pela
   * constraint única do banco, traduzida para `WalletAlreadyExistsError`.
   */
  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const { uow, clock, ids } = this.deps;
    try {
      return await uow.run(async (ctx) => {
        const now = clock.now();

        const existing = await ctx.wallets.findByPlayerAndCurrency(
          command.playerId,
          command.currency,
        );
        if (existing) {
          throw new WalletAlreadyExistsError(existing.id);
        }

        const wallet = Wallet.open({
          id: ids.next(),
          playerId: command.playerId,
          currency: command.currency,
          initialBalance: command.initialBalance,
          now,
        });
        await ctx.wallets.insert(wallet);

        if (command.initialBalance.isPositive()) {
          const opening = WagerTransaction.createProcessed({
            id: ids.next(),
            providerId: 'system',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: canonicalJsonHash({
              walletId: wallet.id,
              playerId: wallet.playerId,
              money: command.initialBalance.toProps(command.currency),
            }),
            type: WagerTransactionType.OPENING,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening:${wallet.id}`,
            gameId: 'system',
            currency: command.currency,
            amount: command.initialBalance,
            referenceExternalTransactionId: null,
            balanceAfter: wallet.balance,
            source: 'SYSTEM',
            correlationId: null,
            createdAt: now,
          });
          // A transação precisa existir antes do lançamento que a referencia.
          await ctx.transactions.insert(opening);

          await ctx.ledger.append(
            WalletLedgerEntry.create({
              id: ids.next(),
              walletId: wallet.id,
              transactionId: opening.id,
              entryType: WagerTransactionType.OPENING,
              direction: LedgerDirection.CREDIT,
              amount: command.initialBalance,
              currency: command.currency,
              balanceBefore: Money.zero(),
              balanceAfter: wallet.balance,
              createdAt: now,
            }),
          );

          const meta = (aggregateId: string): EventMeta => ({
            eventId: ids.next(),
            occurredAt: now,
            aggregateId,
            correlationId: null,
          });
          await enqueueEvent(
            ctx,
            ids,
            'WagerTransaction',
            wagerTransactionProcessed(meta(opening.id), opening),
          );
          await enqueueEvent(
            ctx,
            ids,
            'Wallet',
            walletBalanceChanged(meta(wallet.id), {
              walletId: wallet.id,
              playerId: wallet.playerId,
              transactionId: opening.id,
              direction: LedgerDirection.CREDIT,
              money: command.initialBalance.toProps(command.currency),
              balanceBefore: Money.zero().toProps(command.currency),
              balanceAfter: wallet.balance.toProps(command.currency),
              walletVersion: wallet.version,
            }),
          );
        }

        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationError) {
        throw new WalletAlreadyExistsError(command.playerId);
      }
      throw error;
    }
  }
}

