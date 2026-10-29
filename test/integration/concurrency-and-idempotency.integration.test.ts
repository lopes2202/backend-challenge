import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestingApp } from '../../src/app.module';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { WagerTransactionStatus } from '../../src/domain/models/wager-transaction';
import {
  apiCreateWallet,
  apiGetLedger,
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

describe('Integração — Concorrência Extrema e Idempotência Concorrente', () => {
  /**
   * Valida o bloqueio pessimista por carteira (`SELECT ... FOR UPDATE` em `wallets`):
   * 10 apostas concorrentes de 25.00 BRL disputam um saldo inicial de 100.00 BRL via `Promise.all`.
   * Como o lock no PostgreSQL serializa as transações da mesma carteira:
   * - Exatamente 4 apostas são aplicadas (`PROCESSED`, HTTP 201), consumindo os 100.00 BRL.
   * - As outras 6 apostas são rejeitadas (`REJECTED`, HTTP 422, `INSUFFICIENT_FUNDS`).
   * - Saldo final é estritamente 0.00 BRL (nunca negativo).
   * - `version` da carteira termina em 5 (1 da abertura + 4 débitos; rejeições não incrementam).
   * - O ledger possui exatamente 5 entradas (1 OPENING + 4 BET) com `sequence` contínua (1..5).
   */
  test('10 BETs simultâneas de 25.00 BRL em saldo de 100.00 BRL: 4 PROCESSED, 6 REJECTED e saldo 0.00', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-race-10', '100.00', 'BRL');
    expect(wallet.version).toBe(1);

    const requests = Array.from({ length: 10 }, (_, idx) => {
      const extId = `bet-race-${idx + 1}`;
      return apiSubmitTransaction(h.baseUrl, `prov-race:${extId}`, {
        providerId: 'prov-race',
        externalTransactionId: extId,
        playerId: 'player-race-10',
        walletId: wallet.id,
        roundId: `round-${idx + 1}`,
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });
    });

    const results = await Promise.all(requests);

    const processed = results.filter((r) => r.body.status === WagerTransactionStatus.PROCESSED);
    const rejected = results.filter((r) => r.body.status === WagerTransactionStatus.REJECTED);

    expect(processed).toHaveLength(4);
    expect(rejected).toHaveLength(6);

    for (const r of processed) {
      expect(r.status).toBe(201);
      expect(r.body.idempotentReplay).toBe(false);
    }
    for (const r of rejected) {
      expect(r.status).toBe(422);
      expect(r.body.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    }

    // Verifica estado final da carteira (saldo 0.00 e version 5 = 1 + 4 mutações)
    const walletRes = await fetch(`${h.baseUrl}/wallets/${wallet.id}`);
    const finalWallet = (await walletRes.json()) as { balance: { amount: string }; version: number };
    expect(finalWallet.balance.amount).toBe('0.00');
    expect(finalWallet.version).toBe(5);

    // Verifica sequência estrita e encadeamento contábil do ledger
    const { body: ledger } = await apiGetLedger(h.baseUrl, wallet.id, null, 50);
    expect(ledger.entries).toHaveLength(5);
    expect(ledger.entries.map((e) => Number(e.sequence))).toEqual([1, 2, 3, 4, 5]);
    expect(ledger.entries[0]?.type).toBe('OPENING');
    expect(ledger.entries[4]?.balanceAfter.amount).toBe('0.00');

    // Invariante final obrigatória: saldo materializado == saldo reconstruído pelo ledger
    const { body: reconciliation } = await apiReconcile(h.baseUrl, wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('0.00');
    expect(reconciliation.calculatedBalance.amount).toBe('0.00');
    expect(reconciliation.difference.amount).toBe('0.00');
    expect(reconciliation.checkedEntries).toBe(5);
  });

  /**
   * Cenário obrigatório da Seção 8 do README:
   * Saldo inicial 100.00 BRL e duas apostas simultâneas de 80.00 BRL.
   * Resultado: 1 PROCESSED, 1 REJECTED (INSUFFICIENT_FUNDS), saldo final 20.00 BRL e 1 débito no ledger.
   */
  test('Cenário Seção 8: saldo 100.00 BRL com 2 BETs simultâneas de 80.00 BRL -> saldo final 20.00 BRL', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-sec8', '100.00', 'BRL');

    const [r1, r2] = await Promise.all([
      apiSubmitTransaction(h.baseUrl, 'prov:bet-80-a', {
        providerId: 'prov',
        externalTransactionId: 'bet-80-a',
        playerId: 'player-sec8',
        walletId: wallet.id,
        roundId: 'round-80',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
      apiSubmitTransaction(h.baseUrl, 'prov:bet-80-b', {
        providerId: 'prov',
        externalTransactionId: 'bet-80-b',
        playerId: 'player-sec8',
        walletId: wallet.id,
        roundId: 'round-80',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = [r1.body.status, r2.body.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.PROCESSED, WagerTransactionStatus.REJECTED]);

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('20.00');
    expect(recon.calculatedBalance.amount).toBe('20.00');
    // 1 OPENING + 1 DEBIT = 2 entradas no ledger
    expect(recon.checkedEntries).toBe(2);
  });

  /**
   * Cenário obrigatório da Seção 13.1 do README:
   * A mesma aposta enviada 50 vezes em paralelo com a mesma `Idempotency-Key` e mesmo payload
   * (inclusive com chaves JSON em ordem embaralhada para provar o hash JSON canônico).
   * Como o `SELECT ... FOR UPDATE` na carteira e a constraint `UNIQUE (idempotency_key)` com retry
   * na Unit of Work serializam o acesso:
   * - Exatamente 1 requisição cria a transação (`idempotentReplay: false`, HTTP 201).
   * - As outras 49 retornam replay idempotente (`idempotentReplay: true`, HTTP 200) com o mesmo ID e saldo.
   * - Apenas 1 débito ocorre no banco e no ledger.
   */
  test('50 requisições paralelas com a mesma Idempotency-Key resultam em um único débito', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-idem-50', '100.00', 'BRL');

    const bursts = Array.from({ length: 50 }, (_, idx) => {
      // Alterna a ordem das propriedades do JSON para exercitar o canonicalJsonHash em paralelo
      const payload =
        idx % 2 === 0
          ? {
              providerId: 'prov-idem',
              externalTransactionId: 'ext-idem-50',
              playerId: 'player-idem-50',
              walletId: wallet.id,
              roundId: 'round-idem',
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '30.00', currency: 'BRL' },
            }
          : {
              money: { currency: 'BRL', amount: '30.00' },
              kind: 'BET',
              gameId: 'fortune-chimp',
              roundId: 'round-idem',
              walletId: wallet.id,
              playerId: 'player-idem-50',
              externalTransactionId: 'ext-idem-50',
              providerId: 'prov-idem',
            };
      return apiSubmitTransaction(h.baseUrl, 'prov-idem:ext-idem-50', payload);
    });

    const responses = await Promise.all(bursts);
    const created = responses.filter((r) => r.status === 201 && r.body.idempotentReplay === false);
    const replays = responses.filter((r) => r.status === 200 && r.body.idempotentReplay === true);

    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);

    const uniqueTxIds = new Set(responses.map((r) => r.body.transactionId));
    expect(uniqueTxIds.size).toBe(1);
    for (const r of responses) {
      expect(r.body.balance.amount).toBe('70.00');
    }

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('70.00');
    expect(recon.checkedEntries).toBe(2); // OPENING + 1 BET
  });

  /**
   * Valida detecção de conflito de idempotência via `canonicalJsonHash`:
   * Reutilizar a mesma `Idempotency-Key` alterando qualquer campo de negócio (valor ou tipo)
   * deve ser rejeitado com HTTP 409 (`IdempotencyConflictError`), sem alterar o saldo.
   */
  test('mesma Idempotency-Key com payload divergente retorna 409 Conflict', async () => {
    const { body: wallet } = await apiCreateWallet(h.baseUrl, 'player-conflict', '100.00', 'BRL');

    const first = await apiSubmitTransaction(h.baseUrl, 'prov:key-conflict', {
      providerId: 'prov',
      externalTransactionId: 'tx-conflict-1',
      playerId: 'player-conflict',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(first.status).toBe(201);

    // Mesmo Idempotency-Key mas com valor adulterado (25.00 em vez de 20.00)
    const conflictAmount = await apiSubmitTransaction(h.baseUrl, 'prov:key-conflict', {
      providerId: 'prov',
      externalTransactionId: 'tx-conflict-1',
      playerId: 'player-conflict',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(conflictAmount.status).toBe(409);
    expect(conflictAmount.body.error).toBe('IdempotencyConflictError');

    // Mesmo Idempotency-Key mas com kind alterado (WIN em vez de BET)
    const conflictKind = await apiSubmitTransaction(h.baseUrl, 'prov:key-conflict', {
      providerId: 'prov',
      externalTransactionId: 'tx-conflict-1',
      playerId: 'player-conflict',
      walletId: wallet.id,
      roundId: 'round-1',
      kind: 'WIN',
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(conflictKind.status).toBe(409);

    const { body: recon } = await apiReconcile(h.baseUrl, wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('80.00');
  });

  /**
   * Cenários 13.3 e 13.4 do README:
   * - 3 instâncias simultâneas da aplicação NestJS conectadas ao mesmo PostgreSQL;
   * - Wallets distintas processadas em paralelo sem contenção global, e mesma wallet disputada
   *   entre as 3 instâncias.
   */
  test('3 instâncias simultâneas da aplicação processando carteiras distintas e compartilhadas em paralelo', async () => {
    const app2 = await createTestingApp(h.dataSource, h.sqsClient);
    const app3 = await createTestingApp(h.dataSource, h.sqsClient);
    await app2.listen(0);
    await app3.listen(0);
    const urls = [
      h.baseUrl,
      (await app2.getUrl()).replace('[::1]', 'localhost'),
      (await app3.getUrl()).replace('[::1]', 'localhost'),
    ];

    try {
      const [wA, wB] = await Promise.all([
        apiCreateWallet(urls[0]!, 'player-multi-A', '100.00', 'BRL'),
        apiCreateWallet(urls[1]!, 'player-multi-B', '100.00', 'BRL'),
      ]);

      // 6 BETs de 20.00 em cada carteira distribuídas entre as 3 instâncias (12 em paralelo)
      const calls = [wA.body, wB.body].flatMap((w) =>
        Array.from({ length: 6 }, (_, i) => {
          const targetUrl = urls[i % urls.length]!;
          const extId = `${w.playerId}-bet-${i}`;
          return apiSubmitTransaction(targetUrl, `multi:${extId}`, {
            providerId: 'multi',
            externalTransactionId: extId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: 'r-multi',
            kind: 'BET',
            money: { amount: '20.00', currency: 'BRL' },
          });
        }),
      );

      await Promise.all(calls);

      for (const w of [wA.body, wB.body]) {
        const { body: recon } = await apiReconcile(urls[2]!, w.id);
        expect(recon.consistent).toBe(true);
        // 5 apostas de 20.00 aprovadas (100.00) e 1 rejeitada -> saldo 0.00 e 6 entradas (1 OPENING + 5 BET)
        expect(recon.storedBalance.amount).toBe('0.00');
        expect(recon.checkedEntries).toBe(6);
      }
    } finally {
      await app2.close();
      await app3.close();
    }
  });
});

