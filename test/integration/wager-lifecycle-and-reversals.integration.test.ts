import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { WagerTransactionStatus } from '../../src/domain/models/wager-transaction';
import { PendingReferenceRetryWorker } from '../../src/infra/messaging/workers';
import {
  apiCreateWallet,
  apiReconcile,
  apiSubmitTransaction,
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
});

afterAll(async () => {
  await h?.app.close();
  if (h?.dataSource.isInitialized) await h.dataSource.destroy();
});

describe('Integração — Ciclo de Vida, Fora de Ordem (PENDING_REFERENCE) e Reversões', () => {
  /**
   * Valida o fluxo nominal completo de uma rodada:
   * - Abertura (100.00) -> BET (30.00, DEBIT -> 70.00) -> WIN (50.00, CREDIT -> 120.00) -> LOSS (0.00, sem ledger -> 120.00)
   * - Segunda BET (20.00, DEBIT -> 100.00) -> REFUND (20.00, CREDIT -> 120.00)
   * - Consulta por ID interno e por `(providerId, externalTransactionId)`.
   */
  test('fluxo nominal BET -> WIN -> LOSS e BET -> REFUND com consultas e reconciliação', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-flow', '100.00', 'BRL');

    const bet1 = await apiSubmitTransaction(h.baseUrl, 'prov:bet-1', {
      providerId: 'prov',
      externalTransactionId: 'bet-1',
      playerId: 'player-flow',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(bet1.status).toBe(201);
    expect(bet1.body.balance.amount).toBe('70.00');

    const win1 = await apiSubmitTransaction(h.baseUrl, 'prov:win-1', {
      providerId: 'prov',
      externalTransactionId: 'win-1',
      playerId: 'player-flow',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(win1.status).toBe(201);
    expect(win1.body.balance.amount).toBe('120.00');

    // LOSS não altera saldo nem version da carteira e não adiciona linha no ledger
    const loss1 = await apiSubmitTransaction(h.baseUrl, 'prov:loss-1', {
      providerId: 'prov',
      externalTransactionId: 'loss-1',
      playerId: 'player-flow',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(loss1.status).toBe(201);
    expect(loss1.body.balance.amount).toBe('120.00');

    // BET seguida de REFUND na rodada 2
    const bet2 = await apiSubmitTransaction(h.baseUrl, 'prov:bet-2', {
      providerId: 'prov',
      externalTransactionId: 'bet-2',
      playerId: 'player-flow',
      walletId: wallet.id,
      roundId: 'round-2',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(bet2.body.balance.amount).toBe('100.00');

    const refund2 = await apiSubmitTransaction(h.baseUrl, 'prov:refund-2', {
      providerId: 'prov',
      externalTransactionId: 'refund-2',
      playerId: 'player-flow',
      walletId: wallet.id,
      roundId: 'round-2',
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-2',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(refund2.status).toBe(201);
    expect(refund2.body.balance.amount).toBe('120.00');
    expect(refund2.body.referenceTransactionId).toBe(bet2.body.transactionId);

    // Consulta da transação por ID e por provedor
    const byId = await fetch(`${h.baseUrl}/wagering/transactions/${refund2.body.transactionId}`);
    expect(byId.status).toBe(200);
    const byProvider = await fetch(`${h.baseUrl}/providers/prov/wagering/transactions/refund-2`);
    expect(byProvider.status).toBe(200);

    // 1 OPENING + 1 BET + 1 WIN + 1 BET + 1 REFUND = 5 entradas no ledger (LOSS não gera)
    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('120.00');
    expect(recon.checkedEntries).toBe(5);
  });

  /**
   * Valida as invariantes de reversão (Seção 7 do README):
   * - Uma `BET` já revertida não pode ser revertida uma segunda vez (`REFERENCE_ALREADY_REVERSED`),
   *   tanto pela política de domínio quanto pelo índice parcial `uq_single_processed_reversal`.
   * - Reverter um `WIN` (via `ROLLBACK`) quando o jogador já gastou o saldo deve ser rejeitado
   *   com `NEGATIVE_BALANCE_ON_REVERSAL` (distinto de `INSUFFICIENT_FUNDS`).
   */
  test('bloqueia dupla reversão (REFERENCE_ALREADY_REVERSED) e reversão de WIN que deixaria saldo negativo (NEGATIVE_BALANCE_ON_REVERSAL)', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-rev-rules', '50.00', 'BRL');

    await apiSubmitTransaction(h.baseUrl, 'prov:bet-r', {
      providerId: 'prov',
      externalTransactionId: 'bet-r',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r1',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });

    const firstRefund = await apiSubmitTransaction(h.baseUrl, 'prov:ref-1', {
      providerId: 'prov',
      externalTransactionId: 'ref-1',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-r',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(firstRefund.status).toBe(201);

    // Segunda tentativa de reverter a mesma BET (mesmo via ROLLBACK) deve ser REJECTED (422)
    const secondReversal = await apiSubmitTransaction(h.baseUrl, 'prov:rb-dup', {
      providerId: 'prov',
      externalTransactionId: 'rb-dup',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r1',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-r',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(secondReversal.status).toBe(422);
    expect(secondReversal.body.status).toBe(WagerTransactionStatus.REJECTED);
    expect(secondReversal.body.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Ganha 40.00 (saldo vai a 90.00), depois aposta 70.00 (saldo cai para 20.00)
    await apiSubmitTransaction(h.baseUrl, 'prov:win-big', {
      providerId: 'prov',
      externalTransactionId: 'win-big',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r2',
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
    });
    await apiSubmitTransaction(h.baseUrl, 'prov:bet-spend', {
      providerId: 'prov',
      externalTransactionId: 'bet-spend',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r3',
      kind: 'BET',
      money: { amount: '70.00', currency: 'BRL' },
    });

    // ROLLBACK do WIN de 40.00 com saldo atual de 20.00 -> NEGATIVE_BALANCE_ON_REVERSAL
    const rollbackWin = await apiSubmitTransaction(h.baseUrl, 'prov:rb-win', {
      providerId: 'prov',
      externalTransactionId: 'rb-win',
      playerId: 'player-rev-rules',
      walletId: wallet.id,
      roundId: 'r2',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'win-big',
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect(rollbackWin.status).toBe(422);
    expect(rollbackWin.body.failureCode).toBe(FailureCode.NEGATIVE_BALANCE_ON_REVERSAL);

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('20.00');
  });

  /**
   * Cenário 7.1 e 13.7 do README (Resolução Fora de Ordem):
   * - `ROLLBACK` (ou `REFUND`) chega ANTES da `BET` referenciada.
   * - A API aceita com HTTP 202 (`PENDING_REFERENCE`) sem alterar o saldo da carteira.
   * - A `BET` original chega em seguida e debita 30.00 BRL (saldo 100.00 -> 70.00).
   * - O `PendingReferenceRetryWorker` executa quando `next_retry_at` vence, encontra a `BET`,
   *   credita os 30.00 BRL de volta (saldo -> 100.00) e transiciona para `PROCESSED`.
   */
  test('ROLLBACK entregue antes da BET entra em PENDING_REFERENCE (202) e é resolvido pelo worker após a BET chegar', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-ooo', '100.00', 'BRL');

    // 1. ROLLBACK chega antes da BET existir
    const earlyRollback = await apiSubmitTransaction(h.baseUrl, 'prov:rb-early', {
      providerId: 'prov',
      externalTransactionId: 'rb-early',
      playerId: 'player-ooo',
      walletId: wallet.id,
      roundId: 'round-ooo',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-late',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(earlyRollback.status).toBe(202);
    expect(earlyRollback.body.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(earlyRollback.body.balance.amount).toBe('100.00');

    // 2. A BET atrasada finalmente chega e debita 30.00
    const lateBet = await apiSubmitTransaction(h.baseUrl, 'prov:bet-late', {
      providerId: 'prov',
      externalTransactionId: 'bet-late',
      playerId: 'player-ooo',
      walletId: wallet.id,
      roundId: 'round-ooo',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(lateBet.status).toBe(201);
    expect(lateBet.body.balance.amount).toBe('70.00');

    // Torna o retry imediatamente elegível no banco e roda o worker de pendentes
    await h.dataSource.query(
      `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [earlyRollback.body.transactionId],
    );

    const pendingWorker = h.app.get(PendingReferenceRetryWorker);
    const retriedCount = await pendingWorker.runOnce();
    expect(retriedCount).toBe(1);

    // 3. Verifica que o ROLLBACK pendente foi resolvido como PROCESSED e devolveu os 30.00
    const resolvedRes = await fetch(
      `${h.baseUrl}/wagering/transactions/${earlyRollback.body.transactionId}`,
    );
    const resolvedTx = (await resolvedRes.json()) as {
      status: string;
      balance: { amount: string };
      referenceTransactionId: string;
    };
    expect(resolvedTx.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(resolvedTx.balance.amount).toBe('100.00');
    expect(resolvedTx.referenceTransactionId).toBe(lateBet.body.transactionId);

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('100.00');
    expect(recon.checkedEntries).toBe(3); // OPENING + BET + ROLLBACK
  });

  /**
   * Valida o backoff exponencial e a expiração de `PENDING_REFERENCE` (Seção 7.1):
   * - Quando a referência continua ausente e o TTL ainda não venceu, o worker incrementa
   *   `pending_attempts` e agenda um novo `next_retry_at` no futuro via `exponentialBackoffMs`.
   * - Quando `expires_at <= now` (ou `pending_attempts` atinge o limite), o worker resolve
   *   definitivamente como `REJECTED` com `failureCode = REFERENCE_NOT_FOUND` e publica o evento.
   */
  test('PENDING_REFERENCE reagenda com backoff exponencial e expira como REJECTED (REFERENCE_NOT_FOUND) após o TTL', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-ttl', '100.00', 'BRL');

    const orphanRefund = await apiSubmitTransaction(h.baseUrl, 'prov:refund-orphan', {
      providerId: 'prov',
      externalTransactionId: 'refund-orphan',
      playerId: 'player-ttl',
      walletId: wallet.id,
      roundId: 'round-ttl',
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-never-arrives',
      money: { amount: '15.00', currency: 'BRL' },
    });
    expect(orphanRefund.status).toBe(202);

    const pendingWorker = h.app.get(PendingReferenceRetryWorker);

    // 1ª execução antes de expirar: deve incrementar pending_attempts para 1 e manter PENDING_REFERENCE
    await h.dataSource.query(
      `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [orphanRefund.body.transactionId],
    );
    await pendingWorker.runOnce();

    const afterFirstRetry = (await h.dataSource.query(
      `SELECT status, pending_attempts FROM wager_transactions WHERE id = $1`,
      [orphanRefund.body.transactionId],
    )) as { status: string; pending_attempts: number }[];
    expect(afterFirstRetry[0]?.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(afterFirstRetry[0]?.pending_attempts).toBe(1);

    // Simula vencimento do TTL (`expires_at` no passado) e roda o worker novamente
    await h.dataSource.query(
      `UPDATE wager_transactions
       SET next_retry_at = NOW() - INTERVAL '1 second',
           expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [orphanRefund.body.transactionId],
    );
    await pendingWorker.runOnce();

    const resolvedRes = await fetch(
      `${h.baseUrl}/wagering/transactions/${orphanRefund.body.transactionId}`,
    );
    const expiredTx = (await resolvedRes.json()) as { status: string; failureCode: string };
    expect(expiredTx.status).toBe(WagerTransactionStatus.REJECTED);
    expect(expiredTx.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);

    // Garante que o evento WagerTransactionRejected foi enfileirado na outbox
    const outboxRows = (await h.dataSource.query(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY created_at`,
      [orphanRefund.body.transactionId],
    )) as { event_type: string }[];
    expect(outboxRows.map((r) => r.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });
});

