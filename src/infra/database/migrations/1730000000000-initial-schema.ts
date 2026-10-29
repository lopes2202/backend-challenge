import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1730000000000 implements MigrationInterface {
  name = 'InitialSchema1730000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(128) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_amount NUMERIC(18, 2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT ck_wallets_version CHECK (version >= 1),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      )`);

    await q.query(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(128) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        type VARCHAR(16) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(128) NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL DEFAULT 'unknown',
        currency CHAR(3) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        status VARCHAR(32) NOT NULL,
        failure_code VARCHAR(64),
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        balance_after NUMERIC(18, 2) NOT NULL,
        source VARCHAR(16) NOT NULL,
        correlation_id VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        pending_attempts INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_tx_amount CHECK (amount >= 0),
        CONSTRAINT ck_wager_tx_balance_after CHECK (balance_after >= 0),
        CONSTRAINT ck_wager_tx_status CHECK (status IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE'))
      )`);

    // uma transação PROCESSED só pode ser revertida uma vez
    await q.query(`
      CREATE UNIQUE INDEX uq_single_processed_reversal ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND type IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL`);

    // usado pelo worker de pendentes
    await q.query(`
      CREATE INDEX ix_wager_tx_pending ON wager_transactions (status, next_retry_at)
      WHERE status = 'PENDING_REFERENCE'`);

    await q.query(`
      CREATE TABLE wallet_ledger_entries (
        sequence BIGSERIAL PRIMARY KEY,
        id UUID NOT NULL UNIQUE,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        entry_type VARCHAR(32) NOT NULL,
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(18, 2) NOT NULL,
        balance_after NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ck_ledger_amount CHECK (amount > 0),
        CONSTRAINT ck_ledger_balance_before CHECK (balance_before >= 0),
        CONSTRAINT ck_ledger_balance_after CHECK (balance_after >= 0),
        CONSTRAINT ck_ledger_equation CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      )`);
    await q.query(
      `CREATE INDEX ix_ledger_wallet_sequence ON wallet_ledger_entries (wallet_id, sequence)`,
    );

    // ledger é append-only: nada de update, delete ou truncate
    await q.query(`
      CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only and immutable';
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER trg_ledger_no_update_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable()`);
    await q.query(`
      CREATE TRIGGER trg_ledger_no_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_immutable()`);

    await q.query(`
      CREATE TABLE inbox_messages (
        id UUID PRIMARY KEY,
        consumer_name VARCHAR(128) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id)
      )`);

    await q.query(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        event_type VARCHAR(128) NOT NULL,
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ
      )`);
    await q.query(`
      CREATE INDEX ix_outbox_pending ON outbox_messages (status, next_retry_at)
      WHERE status = 'PENDING'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS outbox_messages`);
    await q.query(`DROP TABLE IF EXISTS inbox_messages`);
    await q.query(`DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON wallet_ledger_entries`);
    await q.query(`DROP TRIGGER IF EXISTS trg_ledger_no_update_delete ON wallet_ledger_entries`);
    await q.query(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    await q.query(`DROP FUNCTION IF EXISTS wallet_ledger_entries_immutable()`);
    await q.query(`DROP TABLE IF EXISTS wager_transactions`);
    await q.query(`DROP TABLE IF EXISTS wallets`);
  }
}

