import type { DataSource, QueryRunner } from 'typeorm';
import { parseCurrency, type Currency } from '../../domain/models/currency';
import type { InboxMessage } from '../../domain/models/inbox-message';
import { Money } from '../../domain/models/money';
import { OutboxMessage } from '../../domain/models/outbox-message';
import { Wallet } from '../../domain/models/wallet';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/models/wallet-ledger-entry';
import {
  WagerTransaction,
  type TransactionSource,
  type WagerTransactionStatus,
  type WagerTransactionType,
} from '../../domain/models/wager-transaction';
import type { FailureCode } from '../../domain/errors/failure-code';
import {
  TransientDatabaseError,
  UniqueConstraintViolationError,
  type InboxRepositoryPort,
  type LedgerReconciliation,
  type OutboxRepositoryPort,
  type TransactionalContext,
  type UnitOfWorkPort,
  type WagerTransactionRepositoryPort,
  type WalletLedgerRepositoryPort,
  type WalletRepositoryPort,
} from '../../application/ports';

// linhas do pg chegam sem tipo; os mapeadores abaixo fazem a conversão
type Row = any;

// converte erros do driver nos erros da aplicação; o resto passa direto
function translate(error: unknown): unknown {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.driverError?.code;
  if (code === '23505') {
    return new UniqueConstraintViolationError(e?.constraint ?? e?.driverError?.constraint ?? null);
  }
  if (code === '40P01' || code === '40001') {
    return new TransientDatabaseError(`Falha transitória do PostgreSQL (${code})`);
  }
  return error;
}

async function sql(qr: QueryRunner, text: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await qr.query(text, params)) as Row[];
  } catch (error) {
    throw translate(error);
  }
}

const walletFromRow = (r: Row): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: parseCurrency(r.currency),
    balance: Money.fromString(r.balance_amount),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const txFromRow = (r: Row): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    type: r.type as WagerTransactionType,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    currency: parseCurrency(r.currency),
    amount: Money.fromString(r.amount),
    status: r.status as WagerTransactionStatus,
    failureCode: (r.failure_code as FailureCode | null) ?? null,
    referenceExternalTransactionId: r.reference_external_transaction_id,
    referenceTransactionId: r.reference_transaction_id,
    balanceAfter: Money.fromString(r.balance_after),
    source: r.source as TransactionSource,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    nextRetryAt: r.next_retry_at,
    expiresAt: r.expires_at,
    pendingAttempts: r.pending_attempts,
  });

const entryFromRow = (r: Row): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    entryType: r.entry_type,
    direction: r.direction as LedgerDirection,
    amount: Money.fromString(r.amount),
    currency: parseCurrency(r.currency),
    balanceBefore: Money.fromString(r.balance_before),
    balanceAfter: Money.fromString(r.balance_after),
    // BIGSERIAL volta como string; bigint evita perder precisão
    sequence: BigInt(r.sequence),
    createdAt: r.created_at,
  });

const outboxFromRow = (r: Row): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    eventType: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    nextRetryAt: r.next_retry_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    publishedAt: r.published_at,
  });

class WalletRepo implements WalletRepositoryPort {
  constructor(private readonly qr: QueryRunner) {}

  async findById(id: string) {
    const rows = await sql(this.qr, `SELECT * FROM wallets WHERE id = $1`, [id]);
    return rows[0] ? walletFromRow(rows[0]) : null;
  }

  // trava a linha até o fim da transação: serializa tudo da mesma carteira
  async findByIdForUpdate(id: string) {
    const rows = await sql(this.qr, `SELECT * FROM wallets WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ? walletFromRow(rows[0]) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: Currency) {
    const rows = await sql(
      this.qr,
      `SELECT * FROM wallets WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    return rows[0] ? walletFromRow(rows[0]) : null;
  }

  async insert(w: Wallet) {
    await sql(
      this.qr,
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [w.id, w.playerId, w.currency, w.balance.toString(), w.version, w.createdAt, w.updatedAt],
    );
  }

  async update(w: Wallet) {
    await sql(
      this.qr,
      `UPDATE wallets SET balance_amount = $2, version = $3, updated_at = $4 WHERE id = $1`,
      [w.id, w.balance.toString(), w.version, w.updatedAt],
    );
  }
}

class TransactionRepo implements WagerTransactionRepositoryPort {
  constructor(private readonly qr: QueryRunner) {}

  private async one(where: string, params: unknown[]) {
    const rows = await sql(this.qr, `SELECT * FROM wager_transactions WHERE ${where}`, params);
    return rows[0] ? txFromRow(rows[0]) : null;
  }

  findById(id: string) {
    return this.one(`id = $1`, [id]);
  }

  findByIdempotencyKey(key: string) {
    return this.one(`idempotency_key = $1`, [key]);
  }

  findByProviderAndExternalId(providerId: string, externalId: string) {
    return this.one(`provider_id = $1 AND external_transaction_id = $2`, [providerId, externalId]);
  }

  async isReversed(referenceTransactionId: string) {
    const rows = await sql(
      this.qr,
      `SELECT 1 FROM wager_transactions
       WHERE reference_transaction_id = $1 AND type IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
       LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insert(t: WagerTransaction) {
    await sql(
      this.qr,
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, type, wallet_id,
         player_id, round_id, game_id, currency, amount, status, failure_code,
         reference_external_transaction_id, reference_transaction_id, balance_after, source,
         correlation_id, created_at, resolved_at, next_retry_at, expires_at, pending_attempts
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash, t.type,
        t.walletId, t.playerId, t.roundId, t.gameId, t.currency, t.amount.toString(), t.status,
        t.failureCode, t.referenceExternalTransactionId, t.referenceTransactionId,
        t.balanceAfter.toString(), t.source, t.correlationId, t.createdAt, t.resolvedAt,
        t.nextRetryAt, t.expiresAt, t.pendingAttempts,
      ],
    );
  }

  // só os campos que mudam na resolução do pendente
  async update(t: WagerTransaction) {
    await sql(
      this.qr,
      `UPDATE wager_transactions SET status = $2, failure_code = $3, reference_transaction_id = $4,
         balance_after = $5, resolved_at = $6, next_retry_at = $7, expires_at = $8, pending_attempts = $9
       WHERE id = $1`,
      [
        t.id, t.status, t.failureCode, t.referenceTransactionId, t.balanceAfter.toString(),
        t.resolvedAt, t.nextRetryAt, t.expiresAt, t.pendingAttempts,
      ],
    );
  }

  // SKIP LOCKED deixa várias instâncias do worker pegarem lotes diferentes
  async claimDuePendingIds(now: Date, limit: number) {
    const rows = await sql(
      this.qr,
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= $1
       ORDER BY next_retry_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((r) => r.id as string);
  }
}

class LedgerRepo implements WalletLedgerRepositoryPort {
  constructor(private readonly qr: QueryRunner) {}

  async append(e: WalletLedgerEntry) {
    await sql(
      this.qr,
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, entry_type, direction, amount, currency,
         balance_before, balance_after, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        e.id, e.walletId, e.transactionId, e.entryType, e.direction, e.amount.toString(),
        e.currency, e.balanceBefore.toString(), e.balanceAfter.toString(), e.createdAt,
      ],
    );
  }

  async findPageByWalletId(walletId: string, afterSequence: bigint | null, limit: number) {
    const rows = await sql(
      this.qr,
      `SELECT * FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND ($2::bigint IS NULL OR sequence > $2::bigint)
       ORDER BY sequence
       LIMIT $3`,
      [walletId, afterSequence === null ? null : afterSequence.toString(), limit],
    );
    return rows.map(entryFromRow);
  }

  async reconcileBalance(walletId: string): Promise<LedgerReconciliation> {
    const rows = await sql(
      this.qr,
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(18, 2) AS net,
              COUNT(*)::int AS entries
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    return { netBalance: Money.fromString(rows[0].net), entriesCount: rows[0].entries };
  }
}

class InboxRepo implements InboxRepositoryPort {
  constructor(private readonly qr: QueryRunner) {}

  // false = mensagem já tinha sido registrada
  async tryRecord(m: InboxMessage) {
    const rows = await sql(
      this.qr,
      `INSERT INTO inbox_messages (id, consumer_name, message_id, received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING id`,
      [m.id, m.consumerName, m.messageId, m.receivedAt],
    );
    return rows.length > 0;
  }
}

class OutboxRepo implements OutboxRepositoryPort {
  constructor(private readonly qr: QueryRunner) {}

  async add(m: OutboxMessage) {
    await sql(
      this.qr,
      `INSERT INTO outbox_messages (
         id, event_type, aggregate_type, aggregate_id, payload, status, attempts,
         next_retry_at, last_error, created_at, published_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
      [
        m.id, m.eventType, m.aggregateType, m.aggregateId, JSON.stringify(m.payload), m.status,
        m.attempts, m.nextRetryAt ?? m.createdAt, m.lastError, m.createdAt, m.publishedAt,
      ],
    );
  }

  async claimPendingBatch(now: Date, limit: number) {
    const rows = await sql(
      this.qr,
      `SELECT * FROM outbox_messages
       WHERE status = 'PENDING' AND next_retry_at <= $1
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(outboxFromRow);
  }

  async markPublished(id: string, now: Date) {
    await sql(
      this.qr,
      `UPDATE outbox_messages SET status = 'PUBLISHED', published_at = $2, last_error = NULL WHERE id = $1`,
      [id, now],
    );
  }

  async markFailed(id: string, error: string, nextRetryAt: Date | null, terminal: boolean) {
    await sql(
      this.qr,
      `UPDATE outbox_messages
       SET attempts = attempts + 1,
           last_error = $2,
           status = CASE WHEN $4::boolean THEN 'FAILED' ELSE 'PENDING' END,
           next_retry_at = COALESCE($3::timestamptz, next_retry_at)
       WHERE id = $1`,
      [id, error, nextRetryAt, terminal],
    );
  }
}

export class PostgresUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly dataSource: DataSource) {}

  private contextFor(qr: QueryRunner): TransactionalContext {
    return {
      wallets: new WalletRepo(qr),
      transactions: new TransactionRepo(qr),
      ledger: new LedgerRepo(qr),
      inbox: new InboxRepo(qr),
      outbox: new OutboxRepo(qr),
    };
  }

  async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction('READ COMMITTED');
      const result = await work(this.contextFor(qr));
      await qr.commitTransaction();
      return result;
    } catch (error) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw translate(error);
    } finally {
      await qr.release();
    }
  }

  // snapshot único para carteira + ledger; BEGIN manual porque o TypeORM não tem READ ONLY
  async runReadOnlyRepeatableRead<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await work(this.contextFor(qr));
      await qr.query('COMMIT');
      return result;
    } catch (error) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      await qr.release();
    }
  }
}

