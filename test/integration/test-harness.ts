import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestingApp } from '../../src/app.module';
import type {
  LedgerPageView,
  ReconciliationView,
  TransactionView,
  WalletView,
} from '../../src/application/dto/views';
import { createDataSource, runMigrations } from '../../src/infra/database/data-source';
import { AwsSqsClient, type SqsClientPort } from '../../src/infra/messaging/workers';

export const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/wagering_test';

export const SQS_ENDPOINT =
  process.env['SQS_ENDPOINT'] ?? process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';

export interface TestHarness {
  app: INestApplication;
  baseUrl: string;
  dataSource: DataSource;
  sqsClient: SqsClientPort;
  rawSqs: SQSClient;
  queues: {
    inputUrl: string;
    dlqUrl: string;
    eventsUrl: string;
  };
}

/**
 * Garante que o banco `wagering_test` exista mesmo se o container PostgreSQL já havia sido
 * criado antes do preenchimento de `docker/postgres/init-test-db.sql`.
 */
export async function ensureTestDatabase(): Promise<void> {
  const parsed = new URL(TEST_DB_URL);
  const dbName = parsed.pathname.replace(/^\//, '') || 'wagering_test';
  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = '/postgres';

  const adminDs = createDataSource(adminUrl.toString());
  await adminDs.initialize();
  try {
    const rows = (await adminDs.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      dbName,
    ])) as unknown[];
    if (rows.length === 0) {
      await adminDs.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await adminDs.destroy();
  }
}

/**
 * Garante que as filas FIFO isoladas de teste existam no LocalStack antes da execução da suíte.
 * Usa filas dedicadas (`*-test.fifo`) e `SQS_WAIT_TIME_SECONDS=1` para evitar competição
 * caso o servidor de desenvolvimento (`bun run start`) esteja rodando em paralelo.
 */
export async function ensureSqsQueues(rawSqs: SQSClient): Promise<{
  inputUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}> {
  const createFifo = async (name: string): Promise<string> => {
    const out = await rawSqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
        },
      }),
    );
    return out.QueueUrl ?? `${SQS_ENDPOINT}/000000000000/${name}`;
  };

  const inputUrl = await createFifo('wager-transactions-test.fifo');
  const dlqUrl = await createFifo('wager-transactions-dlq-test.fifo');
  const eventsUrl = await createFifo('wager-events-test.fifo');

  process.env['SQS_WAGER_QUEUE_URL'] = inputUrl;
  process.env['SQS_WAGER_DLQ_URL'] = dlqUrl;
  process.env['SQS_EVENTS_QUEUE_URL'] = eventsUrl;
  process.env['SQS_WAIT_TIME_SECONDS'] = '1';

  return { inputUrl, dlqUrl, eventsUrl };
}

/**
 * Limpa mensagens residuais de uma fila SQS no LocalStack.
 */
export async function drainQueue(sqs: SqsClientPort, queueUrl: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const msgs = await sqs.receive(queueUrl, 10, 0);
    if (msgs.length === 0) break;
    for (const m of msgs) {
      await sqs.delete(queueUrl, m.receiptHandle);
    }
  }
}

/**
 * Inicializa o ambiente completo de integração (banco `wagering_test` com migrations,
 * filas SQS no LocalStack e aplicação HTTP NestJS em porta efêmera).
 */
export async function setupTestHarness(): Promise<TestHarness> {
  await ensureTestDatabase();

  const rawSqs = new SQSClient({
    endpoint: SQS_ENDPOINT,
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const queues = await ensureSqsQueues(rawSqs);
  const sqsClient = new AwsSqsClient(SQS_ENDPOINT);

  const dataSource = createDataSource(TEST_DB_URL);
  await runMigrations(dataSource);

  const app = await createTestingApp(dataSource, sqsClient);
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  return { app, baseUrl, dataSource, sqsClient, rawSqs, queues };
}

/**
 * Limpa todas as tabelas entre testes sem afetar o banco principal de desenvolvimento.
 * Como `wallet_ledger_entries` possui trigger `BEFORE TRUNCATE` e `BEFORE DELETE` para
 * garantir imutabilidade (append-only), desabilitamos temporariamente os triggers de usuário
 * apenas durante o limpeza do banco de testes (`session_replication_role = replica`).
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  try {
    await qr.query(`SET session_replication_role = 'replica'`);
    await qr.query(
      `TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE`,
    );
  } finally {
    await qr.query(`SET session_replication_role = 'origin'`).catch(() => undefined);
    await qr.release();
  }
}

/** Helper HTTP para criar carteira via `POST /wallets`. */
export async function apiCreateWallet(
  baseUrl: string,
  playerId: string,
  amount: string,
  currency = 'BRL',
): Promise<{ status: number; body: WalletView }> {
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  return { status: res.status, body: (await res.json()) as WalletView };
}

/** Helper HTTP para submeter transação via `POST /wagering/transactions`. */
export async function apiSubmitTransaction(
  baseUrl: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<{ status: number; body: TransactionView & { error?: string; message?: string } }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  };
  if (correlationId) headers['x-correlation-id'] = correlationId;
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as TransactionView & { error?: string; message?: string },
  };
}

/** Helper HTTP para reconciliar carteira via `POST /wallets/:walletId/reconciliation`. */
export async function apiReconcile(
  baseUrl: string,
  walletId: string,
): Promise<{ status: number; body: ReconciliationView }> {
  const res = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as ReconciliationView };
}

/** Helper HTTP para consultar ledger paginado via `GET /wallets/:walletId/ledger`. */
export async function apiGetLedger(
  baseUrl: string,
  walletId: string,
  cursor?: string | null,
  limit?: number,
): Promise<{ status: number; body: LedgerPageView }> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${baseUrl}/wallets/${walletId}/ledger${qs}`);
  return { status: res.status, body: (await res.json()) as LedgerPageView };
}

