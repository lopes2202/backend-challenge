import {
  TransactionNotFoundError,
  ValidationError,
  WalletNotFoundError,
} from '../../domain/errors/domain-errors';
import {
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
  type LedgerPageView,
  type TransactionView,
  type WalletView,
} from '../dto/views';
import type { UnitOfWorkPort } from '../ports';
import { decodeCursor, encodeCursor } from '../utils/cursor';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Consultas somente leitura, sempre sob snapshot consistente. */
export class QueriesUseCase {
  constructor(private readonly deps: { uow: UnitOfWorkPort }) {}

  async getWallet(walletId: string): Promise<WalletView> {
    return this.deps.uow.runReadOnlyRepeatableRead(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return toWalletView(wallet);
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    return this.deps.uow.runReadOnlyRepeatableRead(async (ctx) => {
      const tx = await ctx.transactions.findById(transactionId);
      if (!tx) throw new TransactionNotFoundError(transactionId);
      return toTransactionView(tx, false);
    });
  }

  async getTransactionByProvider(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.deps.uow.runReadOnlyRepeatableRead(async (ctx) => {
      const tx = await ctx.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      return toTransactionView(tx, false);
    });
  }

  /**
   * Paginação por cursor opaco (sequence do ledger). Busca `limit + 1` registros: o extra
   * indica se há próxima página sem precisar de COUNT.
   */
  async getLedger(
    walletId: string,
    cursor: string | null,
    limit: number = DEFAULT_LEDGER_LIMIT,
  ): Promise<LedgerPageView> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new ValidationError(`limit deve ser inteiro entre 1 e ${MAX_LEDGER_LIMIT}`);
    }
    const after = cursor === null ? null : decodeCursor(cursor);

    return this.deps.uow.runReadOnlyRepeatableRead(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const rows = await ctx.ledger.findPageByWalletId(walletId, after, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const hasMore = rows.length > limit;
      if (hasMore && (!last || last.sequence === null)) {
        throw new ValidationError('Lançamento persistido sem sequence');
      }
      return {
        walletId,
        entries: page.map(toLedgerEntryView),
        nextCursor: hasMore && last && last.sequence !== null ? encodeCursor(last.sequence) : null,
      };
    });
  }
}

