import type { Currency } from '../../domain/models/currency';
import type { InboxMessage } from '../../domain/models/inbox-message';
import type { Money } from '../../domain/models/money';
import type { OutboxMessage } from '../../domain/models/outbox-message';
import type { Wallet } from '../../domain/models/wallet';
import type { WalletLedgerEntry } from '../../domain/models/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/models/wager-transaction';

/** Violação de unicidade traduzida pela infraestrutura (ex: chave de idempotência concorrente). */
export class UniqueConstraintViolationError extends Error {
  constructor(
    public readonly constraint: string | null = null,
    message = 'Violação de restrição de unicidade',
  ) {
    super(message);
    this.name = 'UniqueConstraintViolationError';
  }
}

/** Falha transitória (deadlock, serialization failure): a Unit of Work pode ser repetida com segurança. */
export class TransientDatabaseError extends Error {
  constructor(message = 'Falha transitória de banco de dados') {
    super(message);
    this.name = 'TransientDatabaseError';
  }
}

/** Todos os repositórios operam dentro da transação aberta pela Unit of Work. */
export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT ... FOR UPDATE`: serializa operações concorrentes da mesma carteira. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: Currency): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Persiste saldo/version (lock otimista adicional via version na implementação). */
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null>;
  /** Existe REFUND/ROLLBACK PROCESSED apontando para a transação de referência? */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  /** Ids de PENDING_REFERENCE com `nextRetryAt <= now` (ex: `FOR UPDATE SKIP LOCKED`). */
  claimDuePendingIds(now: Date, limit: number): Promise<string[]>;
}

export interface LedgerReconciliation {
  netBalance: Money;
  entriesCount: number;
}

export interface WalletLedgerRepositoryPort {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Página ordenada por sequence crescente, com sequence > afterSequence. */
  findPageByWalletId(
    walletId: string,
    afterSequence: bigint | null,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  /** Σ CREDIT − Σ DEBIT e quantidade de lançamentos da carteira. */
  reconcileBalance(walletId: string): Promise<LedgerReconciliation>;
}

export interface InboxRepositoryPort {
  /** `INSERT ... ON CONFLICT DO NOTHING`; retorna false se a mensagem já havia sido registrada. */
  tryRecord(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepositoryPort {
  add(message: OutboxMessage): Promise<void>;
  claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  markPublished(id: string, now: Date): Promise<void>;
  markFailed(id: string, error: string, nextRetryAt: Date | null, terminal: boolean): Promise<void>;
}

export interface TransactionalContext {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledger: WalletLedgerRepositoryPort;
  inbox: InboxRepositoryPort;
  outbox: OutboxRepositoryPort;
}

export interface UnitOfWorkPort {
  /** Transação de escrita: commit se `work` resolver, rollback se lançar. */
  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
  /** Snapshot `REPEATABLE READ READ ONLY` para leituras consistentes (reconciliação). */
  runReadOnlyRepeatableRead<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}

export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  next(): string;
}

export interface LoggerPort {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface MetricsPort {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  /** Histograma (latência, lag etc.). */
  observe(name: string, value: number, tags?: Record<string, string>): void;
}

