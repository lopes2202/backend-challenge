import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestingApp } from '../../../src/app.module';

// DataSource falso: só valida a injeção do Nest e o mapeamento HTTP, sem banco
const fakeDataSource = { isInitialized: true, query: async () => [] } as unknown as DataSource;

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await createTestingApp(fakeDataSource, {
    send: async () => {},
    receive: async () => [],
    delete: async () => {},
  });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app.close();
});

describe('HTTP', () => {
  test('GET /health/live e /health/ready', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', database: 'up' });
  });

  test('POST /wagering/transactions sem Idempotency-Key retorna 400', async () => {
    const res = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('ValidationError');
  });

  test('POST /wallets com payload inválido retorna 400', async () => {
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'p1', initialBalance: { amount: 10, currency: 'BRL' } }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /wallets/:id/ledger com limit inválido retorna 400', async () => {
    const res = await fetch(`${base}/wallets/w1/ledger?limit=abc`);
    expect(res.status).toBe(400);
  });
});

