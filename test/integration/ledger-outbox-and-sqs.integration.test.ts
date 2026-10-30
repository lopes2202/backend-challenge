import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  OutboxPublisherWorker,
  SqsConsumerWorker,
} from '../../src/infra/messaging/workers';
import {
  apiCreateWallet,
  apiGetLedger,
  apiReconcile,
  apiSubmitTransaction,
  drainQueue,
  resetDatabase,
  setupTestHarness,
  type TestHarness,
} from './test-harness';

let h: TestHarness;

beforeAll(async () => {
  h = await setupTestHarness();
});

beforeEach(async () => {
  await resetDatabase(h.dataSource);
  await drainQueue(h.sqsClient, h.queues.inputUrl);
  await drainQueue(h.sqsClient, h.queues.dlqUrl);
  await drainQueue(h.sqsClient, h.queues.eventsUrl);
});

afterAll(async () => {
  await h?.app.close();
  if (h?.dataSource.isInitialized) await h.dataSource.destroy();
});

describe('Integração — Imutabilidade do Ledger, Paginação, Outbox e SQS (LocalStack)', () => {
  /**
   * Valida a Restrição Inviolável nº 5 e Seção 5 item 9 do README:
   * A tabela `wallet_ledger_entries` é protegida no próprio PostgreSQL por triggers PL/pgSQL
   * (`BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE`) que lançam exceção se qualquer código ou
   * operador tentar modificar ou apagar um lançamento existente.
   */
  test('triggers PostgreSQL bloqueiam UPDATE, DELETE e TRUNCATE em wallet_ledger_entries', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-immutable', '50.00', 'BRL');
    const { body: ledger } = await apiGetLedger(h.baseUrl, wallet.id);
    expect(ledger.entries).toHaveLength(1);
    const entryId = ledger.entries[0]!.entryId;

    // Tentativa de UPDATE direto via SQL deve falhar pelo trigger trg_ledger_no_update_delete
    await expect(
      h.dataSource.query(`UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = $1`, [
        entryId,
      ]),
    ).rejects.toThrow(/append-only and immutable/);

    // Tentativa de DELETE direto via SQL deve falhar pelo trigger trg_ledger_no_update_delete
    await expect(
      h.dataSource.query(`DELETE FROM wallet_ledger_entries WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/append-only and immutable/);

    // Tentativa de TRUNCATE direto deve falhar pelo trigger trg_ledger_no_truncate
    await expect(
      h.dataSource.query(`TRUNCATE TABLE wallet_ledger_entries`),
    ).rejects.toThrow(/append-only and immutable/);
  });

  /**
   * Valida a paginação por cursor opaco em `GET /wallets/:walletId/ledger?cursor=...&limit=...`
   * e a reconciliação sob snapshot `REPEATABLE READ READ ONLY`.
   */
  test('paginação do ledger por cursor opaco percorre todas as entradas sem duplicar nem pular', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-cursor', '100.00', 'BRL');

    for (let i = 1; i <= 4; i++) {
      await apiSubmitTransaction(h.baseUrl, `prov:cursor-bet-${i}`, {
        providerId: 'prov',
        externalTransactionId: `cursor-bet-${i}`,
        playerId: 'player-cursor',
        walletId: wallet.id,
        roundId: `r-${i}`,
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });
    }

    // Total de 5 lançamentos (1 OPENING + 4 BET). Paginando de 2 em 2:
    const page1 = await apiGetLedger(h.baseUrl, wallet.id, null, 2);
    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await apiGetLedger(h.baseUrl, wallet.id, page1.body.nextCursor, 2);
    expect(page2.body.entries).toHaveLength(2);
    expect(page2.body.nextCursor).not.toBeNull();

    const page3 = await apiGetLedger(h.baseUrl, wallet.id, page2.body.nextCursor, 2);
    expect(page3.body.entries).toHaveLength(1);
    expect(page3.body.nextCursor).toBeNull();

    const allSequences = [
      ...page1.body.entries,
      ...page2.body.entries,
      ...page3.body.entries,
    ].map((e) => Number(e.sequence));
    expect(allSequences).toEqual([1, 2, 3, 4, 5]);

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('60.00');
  });

  /**
   * Cenários 11, 13.6 e 13.2 do README (Transactional Outbox com publishers concorrentes):
   * - Criar carteira + aposta grava eventos na tabela `outbox_messages` na mesma transação SQL.
   * - Dois `OutboxPublisherWorker` rodando em paralelo (`Promise.all`) disputam a mesma outbox
   *   usando `SELECT ... FOR UPDATE SKIP LOCKED` e publicam na fila `wager-events.fifo` do LocalStack
   *   sem perder eventos e marcando todos como `PUBLISHED`.
   */
  test('dois OutboxPublisherWorkers concorrentes publicam eventos no SQS (LocalStack) via SKIP LOCKED', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-outbox', '100.00', 'BRL');
    await apiSubmitTransaction(h.baseUrl, 'prov:outbox-bet-1', {
      providerId: 'prov',
      externalTransactionId: 'outbox-bet-1',
      playerId: 'player-outbox',
      walletId: wallet.id,
      roundId: 'round-outbox',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    // Esperados 4 eventos: 2 da abertura (Processed + BalanceChanged) + 2 da BET (Processed + BalanceChanged)
    const pendingBefore = (await h.dataSource.query(
      `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE status = 'PENDING'`,
    )) as { cnt: number }[];
    expect(pendingBefore[0]?.cnt).toBe(4);

    const publisher1 = h.app.get(OutboxPublisherWorker);
    const publisher2 = h.app.get(OutboxPublisherWorker);

    // Dispara duas execuções concorrentes sobre a mesma tabela outbox
    const [pub1, pub2] = await Promise.all([publisher1.runOnce(), publisher2.runOnce()]);
    expect(pub1 + pub2).toBe(4);

    const publishedAfter = (await h.dataSource.query(
      `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE status = 'PUBLISHED'`,
    )) as { cnt: number }[];
    expect(publishedAfter[0]?.cnt).toBe(4);

    // Confere que as mensagens realmente chegaram na fila SQS do LocalStack com envelope version = 1
    const eventsFromSqs = await h.sqsClient.receive(h.queues.eventsUrl, 10, 1);
    expect(eventsFromSqs.length).toBeGreaterThanOrEqual(1);
    const sampleEnvelope = JSON.parse(eventsFromSqs[0]!.body) as {
      version: number;
      eventType: string;
      data: Record<string, unknown>;
    };
    expect(sampleEnvelope.version).toBe(1);
    expect(sampleEnvelope.data).toBeDefined();

    // Remove as mensagens lidas para não deixá-las in-flight bloqueando o grupo FIFO
    for (const m of eventsFromSqs) {
      await h.sqsClient.delete(h.queues.eventsUrl, m.receiptHandle);
    }
  });

  /**
   * Cenários 10, 13.5 e 13.2 do README (SQS Consumer, Inbox Deduplication, Redelivery após Crash e DLQ):
   * 1. Envia uma aposta válida na fila `wager-transactions.fifo`: o `SqsConsumerWorker` consome,
   *    grava na tabela `inbox_messages` + `wager_transactions` + `wallet_ledger_entries` na mesma
   *    transação SQL e dá ACK (`DeleteMessage`).
   * 2. Simula redelivery (ex.: worker morreu após o commit e antes do ACK, e o SQS reentregou a
   *    mesma mensagem com o mesmo `messageId`): a tabela `inbox_messages` detecta a duplicata
   *    (`ON CONFLICT DO NOTHING`) e não duplica o débito.
   * 3. Envia uma poison message (JSON inválido) na fila principal: o consumer encaminha para a
   *    `wager-transactions-dlq.fifo` e remove da fila principal para não travar o grupo FIFO.
   */
  test('SqsConsumerWorker processa mensagem da fila, deduplica redelivery via Inbox e envia poison message para DLQ', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-sqs', '100.00', 'BRL');
    const consumer = h.app.get(SqsConsumerWorker);
    const runNonce = crypto.randomUUID();
    const logicalMessageId = `msg-sqs-bet-${runNonce}`;

    const sqsEvent = {
      messageId: logicalMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs',
        externalTransactionId: `sqs-tx-${runNonce}`,
        idempotencyKey: `provider-sqs:sqs-tx-${runNonce}`,
        playerId: 'player-sqs',
        walletId: wallet.id,
        roundId: 'round-sqs-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      },
    };

    // 1. Publica a mensagem no LocalStack (deduplicationId único por execução por causa da janela de 5 min do SQS FIFO)
    await h.sqsClient.send(h.queues.inputUrl, JSON.stringify(sqsEvent), {
      groupId: `${wallet.id}-1`,
      deduplicationId: `delivery-1-${runNonce}`,
    });
    expect(await consumer.runOnce()).toBe(1);

    // Verifica que debitou 40.00 (saldo -> 60.00) e registrou na tabela inbox_messages
    const inboxRows = (await h.dataSource.query(
      `SELECT * FROM inbox_messages WHERE message_id = $1`,
      [logicalMessageId],
    )) as unknown[];
    expect(inboxRows).toHaveLength(1);

    // 2. Simula redelivery após crash (mesmo messageId lógico entregue uma segunda vez pelo SQS)
    await h.sqsClient.send(h.queues.inputUrl, JSON.stringify(sqsEvent), {
      groupId: `${wallet.id}-2`,
      deduplicationId: `delivery-2-after-crash-${runNonce}`,
    });
    expect(await consumer.runOnce()).toBe(1);

    // Saldo permanece 60.00 (nenhum débito duplicado)
    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('60.00');
    expect(recon.checkedEntries).toBe(2); // OPENING + 1 BET

    // 3. Envia poison message na fila principal e verifica que foi movida para a DLQ
    await h.sqsClient.send(h.queues.inputUrl, `{json-corrompido-${runNonce}`, {
      groupId: `${wallet.id}-poison`,
      deduplicationId: `poison-1-${runNonce}`,
    });
    expect(await consumer.runOnce()).toBe(1);

    const dlqMessages = await h.sqsClient.receive(h.queues.dlqUrl, 10, 1);
    expect(dlqMessages).toHaveLength(1);
    expect(dlqMessages[0]!.body).toContain('SyntaxError');

    // Remove a mensagem da DLQ para não ficar in-flight bloqueando execuções subsequentes em menos de 30s
    for (const m of dlqMessages) {
      await h.sqsClient.delete(h.queues.dlqUrl, m.receiptHandle);
    }
  });
});

