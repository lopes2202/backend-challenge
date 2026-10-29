import { WalletNotFoundError } from '../../domain/errors/domain-errors';
import type { ReconciliationView } from '../dto/views';
import type { ClockPort, LoggerPort, MetricsPort, UnitOfWorkPort } from '../ports';

export class ReconcileWalletUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWorkPort;
      clock: ClockPort;
      logger: LoggerPort;
      metrics: MetricsPort;
    },
  ) {}

  // Compara o saldo guardado com Σ CREDIT − Σ DEBIT do ledger. Roda em snapshot
  // REPEATABLE READ READ ONLY: carteira e ledger vêm do mesmo instante, sem travar escritas.
  async execute(walletId: string): Promise<ReconciliationView> {
    const view = await this.deps.uow.runReadOnlyRepeatableRead(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const { netBalance, entriesCount } = await ctx.ledger.reconcileBalance(walletId);

      const stored = wallet.balance;
      // Money nunca é negativo: a diferença é o módulo (maior − menor)
      const difference =
        stored.compare(netBalance) >= 0
          ? stored.subtract(netBalance)
          : netBalance.subtract(stored);
      const currency = wallet.currency;

      return {
        walletId,
        storedBalance: stored.toProps(currency),
        calculatedBalance: netBalance.toProps(currency),
        difference: difference.toProps(currency),
        consistent: stored.equals(netBalance),
        checkedEntries: entriesCount,
        checkedAt: this.deps.clock.now().toISOString(),
      };
    });

    // divergência nunca é corrigida em silêncio: loga, conta e devolve sinalizada
    if (!view.consistent) {
      const { logger, metrics } = this.deps;
      logger.error('Wallet reconciliation divergence detected', {
        walletId,
        storedBalance: view.storedBalance,
        calculatedBalance: view.calculatedBalance,
        difference: view.difference,
      });
      metrics.increment('wallet.reconciliation.divergence', 1, { walletId });
    }
    return view;
  }
}
