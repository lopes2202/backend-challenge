import { describe, expect, test } from 'bun:test';
import { TransientDatabaseError } from '../../../src/application/ports';
import type { TransactionalContext, UnitOfWorkPort } from '../../../src/application/ports';
import type { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/process-wager-transaction.use-case';
import { OutboxMessage } from '../../../src/domain/models/outbox-message';
import {
  DEFAULT_CONSUMER_CONFIG,
  DEFAULT_OUTBOX_CONFIG,
  OutboxPublisherWorker,
  SqsConsumerWorker,
  type SqsClientPort,
  type SqsMessage,
} from '../../../src/infra/messaging/workers';
import { InMemoryMetrics, StructuredJsonLogger } from '../../../src/infra/observability/runtime-services';

const logger = new StructuredJsonLogger();
const IN = 'in-queue';
const DLQ = 'dlq-queue';

const payload = {
  providerId: 'prov',
  externalTransactionId: 'ext1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

function fakeSqs(messages: SqsMessage[], failSend = false) {
  const calls: string[] = [];
  const sent: { queue: string; body: string }[] = [];
  const sqs: SqsClientPort = {
    receive: async () => messages,
    delete: async (queue) => void calls.push(`delete:${queue}`),
    send: async (queue, body) => {
      if (failSend) throw new Error('sqs fora do ar');
      calls.push(`send:${queue}`);
      sent.push({ queue, body });
    },
  };
  return { sqs, calls, sent };
}

const msg = (body: string, receiveCount = 1): SqsMessage => ({
  messageId: 'sqs-1',
  body,
  receiptHandle: 'rh-1',
  receiveCount,
});

function consumer(sqs: SqsClientPort, execute: () => Promise<unknown>, calls: string[]) {
  const processWager = {
    execute: async () => {
      calls.push('execute');
      return execute();
    },
  } as unknown as ProcessWagerTransactionUseCase;
  return new SqsConsumerWorker({
    sqs,
    processWager,
    logger,
    metrics: new InMemoryMetrics(),
    config: { ...DEFAULT_CONSUMER_CONFIG, queueUrl: IN, dlqUrl: DLQ },
  });
}

describe('SqsConsumerWorker', () => {
  test('ack só depois do execute concluir', async () => {
    const { sqs, calls } = fakeSqs([msg(JSON.stringify({ messageId: 'm1', data: payload }))]);
    await consumer(sqs, async () => ({}), calls).runOnce();
    expect(calls).toEqual(['execute', `delete:${IN}`]);
  });

  test('JSON inválido vai para a DLQ e sai da fila principal', async () => {
    const { sqs, calls, sent } = fakeSqs([msg('{nao-e-json')]);
    await consumer(sqs, async () => ({}), calls).runOnce();
    expect(calls).toEqual([`send:${DLQ}`, `delete:${IN}`]);
    expect(sent[0]?.queue).toBe(DLQ);
  });

  test('payload inválido (ValidationError) vai para a DLQ sem executar', async () => {
    const { sqs, calls } = fakeSqs([msg(JSON.stringify({ data: { ...payload, kind: 'XYZ' } }))]);
    await consumer(sqs, async () => ({}), calls).runOnce();
    expect(calls).toEqual([`send:${DLQ}`, `delete:${IN}`]);
  });

  test('erro transitório não dá ack nem manda para a DLQ', async () => {
    const { sqs, calls } = fakeSqs([msg(JSON.stringify({ data: payload }))]);
    await consumer(
      sqs,
      async () => {
        throw new TransientDatabaseError();
      },
      calls,
    ).runOnce();
    expect(calls).toEqual(['execute']);
  });

  test('erro transitório após o limite de entregas vai para a DLQ', async () => {
    const { sqs, calls } = fakeSqs([msg(JSON.stringify({ data: payload }), 5)]);
    await consumer(
      sqs,
      async () => {
        throw new TransientDatabaseError();
      },
      calls,
    ).runOnce();
    expect(calls).toEqual(['execute', `send:${DLQ}`, `delete:${IN}`]);
  });

  test('falha ao enviar para a DLQ mantém a mensagem na fila', async () => {
    const { sqs, calls } = fakeSqs([msg('{nao-e-json')], true);
    await consumer(sqs, async () => ({}), calls).runOnce();
    expect(calls).toEqual([]);
  });
});

describe('OutboxPublisherWorker', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const pending = () =>
    OutboxMessage.create({
      id: 'o1',
      eventType: 'WalletBalanceChanged',
      aggregateType: 'Wallet',
      aggregateId: 'w1',
      payload: { a: 1 },
      createdAt: now,
    });

  function worker(failSend: boolean) {
    const marks: string[] = [];
    const ctx = {
      outbox: {
        claimPendingBatch: async () => [pending()],
        markPublished: async (id: string) => void marks.push(`published:${id}`),
        markFailed: async (id: string, _e: string, next: Date | null, terminal: boolean) =>
          void marks.push(`failed:${id}:${terminal}:${next !== null}`),
      },
    } as unknown as TransactionalContext;
    const uow: UnitOfWorkPort = { run: (w) => w(ctx), runReadOnlyRepeatableRead: (w) => w(ctx) };
    const { sqs, sent } = fakeSqs([], failSend);
    const w = new OutboxPublisherWorker({
      uow,
      sqs,
      clock: { now: () => now },
      logger,
      metrics: new InMemoryMetrics(),
      config: { ...DEFAULT_OUTBOX_CONFIG, eventsQueueUrl: 'events' },
    });
    return { w, marks, sent };
  }

  test('publica e marca como publicado', async () => {
    const { w, marks, sent } = worker(false);
    expect(await w.runOnce()).toBe(1);
    expect(marks).toEqual(['published:o1']);
    expect(sent[0]?.body).toBe(JSON.stringify({ a: 1 }));
  });

  test('falha de envio reagenda com backoff (não terminal)', async () => {
    const { w, marks } = worker(true);
    expect(await w.runOnce()).toBe(0);
    expect(marks).toEqual(['failed:o1:false:true']);
  });
});

