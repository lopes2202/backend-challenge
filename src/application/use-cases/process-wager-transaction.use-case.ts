import {
  IdempotencyConflictError,
  ValidationError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../domain/errors/domain-errors';
import { FailureCode } from '../../domain/errors/failure-code';
import {
  walletBalanceChanged,
  wagerTransactionPendingReference,
  wagerTransactionProcessed,
  wagerTransactionRejected,
  type EventMeta,
} from '../../domain/events/wager-events';
import { InboxMessage } from '../../domain/models/inbox-message';
import type { Currency } from '../../domain/models/currency';
import type { Money } from '../../domain/models/money';
import type { Wallet } from '../../domain/models/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/models/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../domain/models/wager-transaction';
import { exponentialBackoffMs } from '../../domain/services/backoff';
import { evaluateReversal } from '../../domain/services/reversal-policy';
import type { WagerTransactionCommand } from '../dto/wager-transaction-command';
import {
  TransientDatabaseError,
  UniqueConstraintViolationError,
  type ClockPort,
  type IdGeneratorPort,
  type LoggerPort,
  type MetricsPort,
  type TransactionalContext,
  type UnitOfWorkPort,
} from '../ports';
import { enqueueEvent } from '../utils/outbox-events';

export interface ProcessResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
  duplicateMessage: boolean;
}

export interface ProcessWagerConfig {
  /** Tempo máximo (ms) que uma reversão aguarda a referência chegar. */
  pendingTtlMs: number;
  /** Máximo de reavaliações de uma transação PENDING_REFERENCE. */
  pendingMaxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Tentativas da Unit of Work em caso de corrida de unicidade ou falha transitória. */
  uowMaxAttempts: number;
}

export const DEFAULT_PROCESS_WAGER_CONFIG: ProcessWagerConfig = {
  pendingTtlMs: 15 * 60_000,
  pendingMaxAttempts: 10,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  uowMaxAttempts: 3,
};

export interface ProcessWagerDeps {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  config?: Partial<ProcessWagerConfig>;
}

/** Dados mínimos para decidir o efeito de uma transação (comando novo ou PENDING reavaliada). */
interface DecisionInput {
  type: WagerTransactionType;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  currency: Currency;
  amount: Money;
  referenceExternalTransactionId: string | null;
}

type Decision =
  | {
      status: 'PROCESSED';
      /** `null` quando não há movimentação (LOSS): sem ledger e sem alteração da wallet. */
      direction: LedgerDirection | null;
      balanceBefore: Money;
      referenceTransactionId: string | null;
    }
  | { status: 'REJECTED'; failureCode: FailureCode }
  | { status: 'PENDING' };

export class ProcessWagerTransactionUseCase {
  private readonly config: ProcessWagerConfig;

  constructor(private readonly deps: ProcessWagerDeps) {
    this.config = { ...DEFAULT_PROCESS_WAGER_CONFIG, ...deps.config };
  }

  /**
   * Caso de uso compartilhado por HTTP e SQS. Corrida de duas requisições com a mesma chave
   * pode estourar `UniqueConstraintViolationError` no insert; ao repetir a Unit of Work, a
   * segunda tentativa já enxerga a transação vencedora e vira replay idempotente.
   */
  async execute(command: WagerTransactionCommand): Promise<ProcessResult> {
    const startedAt = Date.now();
    try {
      return await this.withRetry(() =>
        this.deps.uow.run((ctx) => this.executeInTx(ctx, command)),
      );
    } finally {
      this.deps.metrics.observe('wager.processing_ms', Date.now() - startedAt);
    }
  }

  private async executeInTx(
    ctx: TransactionalContext,
    command: WagerTransactionCommand,
  ): Promise<ProcessResult> {
    const { clock, ids, metrics } = this.deps;
    const now = clock.now();

    // 1. Lock pessimista da carteira (SELECT ... FOR UPDATE): serializa tudo da mesma wallet,
    //    inclusive checagem de saldo, idempotência e isReversed.
    const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // 2. Deduplicação de mensagem SQS via Inbox. A gravação do inbox está na mesma transação:
    //    se algo falhar adiante, o registro também sofre rollback e a mensagem pode ser reentregue.
    if (command.inbox) {
      const recorded = await ctx.inbox.tryRecord(
        InboxMessage.receive({
          id: ids.next(),
          consumerName: command.inbox.consumerName,
          messageId: command.inbox.messageId,
          receivedAt: now,
        }),
      );
      if (!recorded) {
        const original = await this.findExisting(ctx, command);
        if (original) {
          metrics.increment('wager.duplicate_message', 1, { source: command.source });
          return { transaction: original, idempotentReplay: true, duplicateMessage: true };
        }
        // Inbox existe mas a transação não: segue o fluxo normal (a idempotência persistente protege).
      }
    }

    // 3. Idempotência persistente: mesma chave (ou mesmo par provider/externalId) com payload
    //    idêntico é replay; com payload diferente é conflito (HTTP 409).
    const existing = await this.findExisting(ctx, command);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      metrics.increment('wager.idempotent_replay', 1, { source: command.source });
      return { transaction: existing, idempotentReplay: true, duplicateMessage: false };
    }

    // 4. A carteira precisa pertencer ao jogador e ter a mesma moeda do comando.
    if (wallet.playerId !== command.playerId) {
      throw new WalletPlayerMismatchError(wallet.id, command.playerId);
    }
    if (wallet.currency !== command.currency) {
      throw new WalletCurrencyMismatchError(wallet.currency, command.currency);
    }

    // 5. Decisão de negócio (pode mutar o agregado em memória; só persiste no passo 6).
    const decision = await this.decide(ctx, wallet, command, now);

    // 6. Persistência atômica: transação, wallet/ledger e outbox no mesmo commit.
    const transaction = await this.recordEffects(ctx, wallet, command, decision, now);
    metrics.increment('wager.processed', 1, { status: transaction.status, type: command.type });
    return { transaction, idempotentReplay: false, duplicateMessage: false };
  }

  /**
   * Reavalia uma transação PENDING_REFERENCE sob o lock da carteira (uso do worker de retry).
   * Resolve como PROCESSED/REJECTED (inclusive REFERENCE_NOT_FOUND por TTL ou maxAttempts)
   * ou reagenda com backoff exponencial. Retorna `null` se a transação não existe.
   */
  async retryPending(transactionId: string): Promise<WagerTransaction | null> {
    return this.withRetry(() =>
      this.deps.uow.run(async (ctx) => {
        const { clock } = this.deps;
        const peek = await ctx.transactions.findById(transactionId);
        if (!peek || !peek.isPending()) {
          return peek;
        }

        // Lock da carteira primeiro; depois relê a transação, pois outro worker pode tê-la
        // resolvido enquanto aguardávamos o lock (double-check).
        const wallet = await ctx.wallets.findByIdForUpdate(peek.walletId);
        if (!wallet) {
          throw new WalletNotFoundError(peek.walletId);
        }
        const tx = await ctx.transactions.findById(transactionId);
        if (!tx || !tx.isPending()) {
          return tx;
        }

        const now = clock.now();
        const decision = await this.decide(ctx, wallet, tx, now);

        if (decision.status === 'PENDING') {
          const attempts = tx.pendingAttempts + 1;
          const expired =
            (tx.expiresAt !== null && now.getTime() >= tx.expiresAt.getTime()) ||
            attempts >= this.config.pendingMaxAttempts;
          if (expired) {
            tx.resolveAsRejected(
              { failureCode: FailureCode.REFERENCE_NOT_FOUND, balanceAfter: wallet.balance },
              now,
            );
            await ctx.transactions.update(tx);
            await enqueueEvent(ctx, this.deps.ids, 'WagerTransaction', wagerTransactionRejected(this.meta(tx, now), tx));
          } else {
            const delay = exponentialBackoffMs(
              attempts,
              this.config.backoffBaseMs,
              this.config.backoffMaxMs,
            );
            tx.scheduleRetry(new Date(now.getTime() + delay), now);
            await ctx.transactions.update(tx);
          }
          return tx;
        }

        if (decision.status === 'REJECTED') {
          tx.resolveAsRejected(
            { failureCode: decision.failureCode, balanceAfter: wallet.balance },
            now,
          );
          await ctx.transactions.update(tx);
          await enqueueEvent(ctx, this.deps.ids, 'WagerTransaction', wagerTransactionRejected(this.meta(tx, now), tx));
          return tx;
        }

        tx.resolveAsProcessed(
          {
            balanceAfter: wallet.balance,
            referenceTransactionId: decision.referenceTransactionId ?? '',
          },
          now,
        );
        await ctx.transactions.update(tx);
        await this.persistMovement(ctx, wallet, tx, decision, now);
        await enqueueEvent(ctx, this.deps.ids, 'WagerTransaction', wagerTransactionProcessed(this.meta(tx, now), tx));
        return tx;
      }),
    );
  }

  private async findExisting(
    ctx: TransactionalContext,
    command: WagerTransactionCommand,
  ): Promise<WagerTransaction | null> {
    return (
      (await ctx.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
      (await ctx.transactions.findByProviderAndExternalId(
        command.providerId,
        command.externalTransactionId,
      ))
    );
  }

  /** Regras de negócio por tipo. Só muta `wallet` em memória quando o resultado é PROCESSED. */
  private async decide(
    ctx: TransactionalContext,
    wallet: Wallet,
    input: DecisionInput,
    now: Date,
  ): Promise<Decision> {
    const balanceBefore = wallet.balance;
    switch (input.type) {
      case WagerTransactionType.BET: {
        // Sem saldo: rejeita sem tocar em saldo nem version.
        if (!wallet.canDebit(input.amount)) {
          return { status: 'REJECTED', failureCode: FailureCode.INSUFFICIENT_FUNDS };
        }
        wallet.debit(input.amount, now);
        return {
          status: 'PROCESSED',
          direction: LedgerDirection.DEBIT,
          balanceBefore,
          referenceTransactionId: null,
        };
      }
      case WagerTransactionType.WIN: {
        wallet.credit(input.amount, now);
        return {
          status: 'PROCESSED',
          direction: LedgerDirection.CREDIT,
          balanceBefore,
          referenceTransactionId: null,
        };
      }
      case WagerTransactionType.LOSS:
        // O valor da perda já foi debitado na BET: não move saldo nem gera ledger.
        return {
          status: 'PROCESSED',
          direction: null,
          balanceBefore,
          referenceTransactionId: null,
        };
      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK: {
        const referenceExternalId = input.referenceExternalTransactionId;
        const reference =
          referenceExternalId === null
            ? null
            : await ctx.transactions.findByProviderAndExternalId(
                input.providerId,
                referenceExternalId,
              );
        const alreadyReversed = reference ? await ctx.transactions.isReversed(reference.id) : false;

        const verdict = evaluateReversal(
          {
            type: input.type,
            providerId: input.providerId,
            playerId: input.playerId,
            walletId: input.walletId,
            roundId: input.roundId,
            currency: input.currency,
            amount: input.amount,
          },
          reference,
          alreadyReversed,
        );

        if (verdict.outcome === 'NOT_YET_AVAILABLE') {
          return { status: 'PENDING' };
        }
        if (verdict.outcome === 'REJECT') {
          return { status: 'REJECTED', failureCode: verdict.failureCode };
        }
        if (verdict.direction === LedgerDirection.CREDIT) {
          wallet.credit(input.amount, now);
        } else {
          // Reverter WIN/REFUND retira saldo: se não houver, falha com código próprio.
          if (!wallet.canDebit(input.amount)) {
            return {
              status: 'REJECTED',
              failureCode: FailureCode.NEGATIVE_BALANCE_ON_REVERSAL,
            };
          }
          wallet.debitForReversal(input.amount, now);
        }
        return {
          status: 'PROCESSED',
          direction: verdict.direction,
          balanceBefore,
          referenceTransactionId: verdict.reference.id,
        };
      }
      default:
        throw new ValidationError(`Tipo de transação não processável: ${input.type}`);
    }
  }

  /** Insere a transação, atualiza wallet/ledger (se houve movimento) e grava eventos no outbox. */
  private async recordEffects(
    ctx: TransactionalContext,
    wallet: Wallet,
    command: WagerTransactionCommand,
    decision: Decision,
    now: Date,
  ): Promise<WagerTransaction> {
    const { ids } = this.deps;
    const base = {
      id: ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      type: command.type,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      currency: command.currency,
      amount: command.amount,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      balanceAfter: wallet.balance,
      source: command.source,
      correlationId: command.correlationId,
      createdAt: now,
    };

    if (decision.status === 'PENDING') {
      const tx = WagerTransaction.createPendingReference({
        ...base,
        nextRetryAt: new Date(
          now.getTime() + exponentialBackoffMs(0, this.config.backoffBaseMs, this.config.backoffMaxMs),
        ),
        expiresAt: new Date(now.getTime() + this.config.pendingTtlMs),
      });
      await ctx.transactions.insert(tx);
      await enqueueEvent(ctx, ids, 'WagerTransaction', wagerTransactionPendingReference(this.meta(tx, now), tx));
      return tx;
    }

    if (decision.status === 'REJECTED') {
      const tx = WagerTransaction.createRejected({ ...base, failureCode: decision.failureCode });
      await ctx.transactions.insert(tx);
      await enqueueEvent(ctx, ids, 'WagerTransaction', wagerTransactionRejected(this.meta(tx, now), tx));
      return tx;
    }

    const tx = WagerTransaction.createProcessed({
      ...base,
      referenceTransactionId: decision.referenceTransactionId,
    });
    // A transação é inserida antes do ledger, que a referencia.
    await ctx.transactions.insert(tx);
    await this.persistMovement(ctx, wallet, tx, decision, now);
    await enqueueEvent(ctx, ids, 'WagerTransaction', wagerTransactionProcessed(this.meta(tx, now), tx));
    return tx;
  }

  /** Persiste wallet + lançamento + evento de saldo, somente quando há movimentação. */
  private async persistMovement(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    decision: Extract<Decision, { status: 'PROCESSED' }>,
    now: Date,
  ): Promise<void> {
    if (decision.direction === null) {
      return;
    }
    const { ids } = this.deps;
    await ctx.wallets.update(wallet);
    await ctx.ledger.append(
      WalletLedgerEntry.create({
        id: ids.next(),
        walletId: wallet.id,
        transactionId: tx.id,
        entryType: tx.type,
        direction: decision.direction,
        amount: tx.amount,
        currency: tx.currency,
        balanceBefore: decision.balanceBefore,
        balanceAfter: wallet.balance,
        createdAt: now,
      }),
    );
    await enqueueEvent(
      ctx,
      ids,
      'Wallet',
      walletBalanceChanged(
        { ...this.meta(tx, now), eventId: ids.next(), aggregateId: wallet.id },
        {
          walletId: wallet.id,
          playerId: wallet.playerId,
          transactionId: tx.id,
          direction: decision.direction,
          money: tx.amount.toProps(tx.currency),
          balanceBefore: decision.balanceBefore.toProps(tx.currency),
          balanceAfter: wallet.balance.toProps(tx.currency),
          walletVersion: wallet.version,
        },
      ),
    );
  }

  private meta(tx: WagerTransaction, now: Date): EventMeta {
    return {
      eventId: this.deps.ids.next(),
      occurredAt: now,
      aggregateId: tx.id,
      correlationId: tx.correlationId,
    };
  }

  /** Repete a Unit of Work inteira em corrida de unicidade ou falha transitória do banco. */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await work();
      } catch (error) {
        const retryable =
          error instanceof UniqueConstraintViolationError ||
          error instanceof TransientDatabaseError;
        if (!retryable || attempt >= this.config.uowMaxAttempts) {
          throw error;
        }
        const transient = error instanceof TransientDatabaseError;
        this.deps.logger.warn('Repetindo Unit of Work', { attempt, reason: (error as Error).name });
        // deadlock/serialization contam como conflito de lock
        this.deps.metrics.increment(transient ? 'wager.lock_conflict' : 'wager.uow_retry');
      }
    }
  }
}

