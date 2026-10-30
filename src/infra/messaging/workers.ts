import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../../domain/errors/domain-errors';
import { exponentialBackoffMs } from '../../domain/services/backoff';
import {
  parseWagerTransactionCommand,
} from '../../application/dto/wager-transaction-command';
import type {
  ClockPort,
  LoggerPort,
  MetricsPort,
  UnitOfWorkPort,
} from '../../application/ports';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';

export interface SqsMessage {
  messageId: string;
  body: string;
  receiptHandle: string;
  receiveCount: number;
}

export interface SqsSendOptions {
  groupId?: string;
  deduplicationId?: string;
}

export interface SqsClientPort {
  send(queueUrl: string, body: string, options?: SqsSendOptions): Promise<void>;
  receive(queueUrl: string, maxMessages: number, waitSeconds: number): Promise<SqsMessage[]>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
}

export class AwsSqsClient implements SqsClientPort {
  private readonly client: SQSClient;

  constructor(endpoint: string = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566') {
    this.client = new SQSClient({
      endpoint,
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      // LocalStack aceita qualquer credencial; em AWS real vêm do ambiente
      credentials:
        process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']
          ? undefined
          : { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  }

  async send(queueUrl: string, body: string, options: SqsSendOptions = {}): Promise<void> {
    // grupo e deduplicação só existem em fila FIFO
    const fifo = queueUrl.endsWith('.fifo');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        ...(fifo && {
          MessageGroupId: options.groupId ?? 'default',
          MessageDeduplicationId: options.deduplicationId ?? crypto.randomUUID(),
        }),
      }),
    );
  }

  async receive(queueUrl: string, maxMessages: number, waitSeconds: number): Promise<SqsMessage[]> {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (out.Messages ?? []).map((m) => ({
      messageId: m.MessageId ?? '',
      body: m.Body ?? '',
      receiptHandle: m.ReceiptHandle ?? '',
      receiveCount: Number(m.Attributes?.['ApproximateReceiveCount'] ?? '1'),
    }));
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }
}

// base comum: runOnce() para testes, start()/stop() para rodar continuamente
abstract class IntervalWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    protected readonly logger: LoggerPort,
    private readonly name: string,
    private readonly intervalMs: number,
  ) {}

  abstract runOnce(): Promise<number>;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // não empilha execuções se a anterior ainda estiver rodando
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(`Worker ${this.name} falhou`, { error: (error as Error).message }),
        )
        .finally(() => {
          this.inFlight = null;
        });
    }, this.intervalMs);
  }

  // no SIGTERM: para de buscar trabalho novo e espera o lote atual terminar
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}

export interface SqsConsumerConfig {
  queueUrl: string;
  dlqUrl?: string | undefined;
  consumerName: string;
  maxMessages: number;
  waitSeconds: number;
  intervalMs: number;
  /** Depois de tantas entregas com erro desconhecido, a mensagem vai para a DLQ. */
  maxReceiveCount: number;
}

export const DEFAULT_CONSUMER_CONFIG: Omit<SqsConsumerConfig, 'queueUrl'> = {
  consumerName: 'sqs-wager-consumer',
  maxMessages: 10,
  waitSeconds: 2,
  intervalMs: 500,
  maxReceiveCount: 5,
};

export class SqsConsumerWorker extends IntervalWorker {
  constructor(
    private readonly deps: {
      sqs: SqsClientPort;
      processWager: ProcessWagerTransactionUseCase;
      logger: LoggerPort;
      metrics: MetricsPort;
      config: SqsConsumerConfig;
    },
  ) {
    super(deps.logger, 'sqs-consumer', deps.config.intervalMs);
  }

  async runOnce(): Promise<number> {
    const { sqs, config } = this.deps;
    const messages = await sqs.receive(config.queueUrl, config.maxMessages, config.waitSeconds);
    // em sequência para respeitar a ordem do grupo FIFO
    for (const message of messages) {
      await this.handle(message);
    }
    return messages.length;
  }

  private async handle(message: SqsMessage): Promise<void> {
    const { sqs, processWager, logger, metrics, config } = this.deps;
    let logicalId = message.messageId;
    try {
      const envelope = JSON.parse(message.body) as Record<string, unknown>;
      if (typeof envelope['messageId'] === 'string') logicalId = envelope['messageId'];
      const data = (envelope['data'] ?? envelope) as Record<string, unknown>;

      const command = parseWagerTransactionCommand(data, {
        source: 'SQS',
        idempotencyKey: typeof data['idempotencyKey'] === 'string' ? data['idempotencyKey'] : null,
        correlationId: logicalId,
        inbox: { consumerName: config.consumerName, messageId: logicalId },
      });
      await processWager.execute(command);

      // ack só depois do commit; REJECTED, PENDING e duplicada já estão gravadas
      await sqs.delete(config.queueUrl, message.receiptHandle);
      metrics.increment('sqs.consumed');
    } catch (error) {
      const permanent = error instanceof DomainError || error instanceof SyntaxError;
      const exhausted = message.receiveCount >= config.maxReceiveCount;
      if (!permanent && !exhausted) {
        // transitório: sem ack, o SQS reentrega depois da visibilidade
        logger.warn('Falha transitória no consumer; sem ack', {
          messageId: logicalId,
          attempt: message.receiveCount,
          error: (error as Error).message,
        });
        metrics.increment('sqs.retry');
        return;
      }
      await this.sendToDlq(message, logicalId, error as Error);
    }
  }

  private async sendToDlq(message: SqsMessage, logicalId: string, error: Error): Promise<void> {
    const { sqs, logger, metrics, config } = this.deps;
    if (config.dlqUrl) {
      try {
        await sqs.send(
          config.dlqUrl,
          JSON.stringify({ messageId: logicalId, error: error.name, reason: error.message, body: message.body }),
          { groupId: logicalId || message.messageId || 'dlq', deduplicationId: `${logicalId}:${message.messageId}` },
        );
      } catch (dlqError) {
        // sem DLQ não dá para descartar: deixa a mensagem voltar
        logger.error('Falha ao enviar para a DLQ; sem ack', {
          messageId: logicalId,
          error: (dlqError as Error).message,
        });
        return;
      }
    } else {
      logger.error('Mensagem inválida descartada: DLQ não configurada', {
        messageId: logicalId,
        error: error.message,
      });
    }
    // remove da fila principal para não travar o grupo FIFO
    await sqs.delete(config.queueUrl, message.receiptHandle);
    metrics.increment('sqs.dlq');
    logger.warn('Mensagem enviada para a DLQ', { messageId: logicalId, reason: error.name });
  }
}

export interface OutboxPublisherConfig {
  eventsQueueUrl: string;
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  intervalMs: number;
}

export const DEFAULT_OUTBOX_CONFIG: Omit<OutboxPublisherConfig, 'eventsQueueUrl'> = {
  batchSize: 50,
  maxAttempts: 10,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  intervalMs: 1_000,
};

export class OutboxPublisherWorker extends IntervalWorker {
  constructor(
    private readonly deps: {
      uow: UnitOfWorkPort;
      sqs: SqsClientPort;
      clock: ClockPort;
      logger: LoggerPort;
      metrics: MetricsPort;
      config: OutboxPublisherConfig;
    },
  ) {
    super(deps.logger, 'outbox-publisher', deps.config.intervalMs);
  }

  // O lote fica travado (SKIP LOCKED) até o commit: dois publishers nunca pegam a mesma
  // linha. Se o processo cair após enviar e antes do commit, o evento sai de novo; o
  // MessageDeduplicationId (id da outbox) e o eventId protegem o consumidor.
  async runOnce(): Promise<number> {
    const { uow, sqs, clock, metrics, config } = this.deps;
    return uow.run(async (ctx) => {
      const now = clock.now();
      const batch = await ctx.outbox.claimPendingBatch(now, config.batchSize);
      let published = 0;
      for (const message of batch) {
        metrics.observe('outbox.lag_ms', now.getTime() - message.createdAt.getTime());
        try {
          await sqs.send(config.eventsQueueUrl, JSON.stringify(message.payload), {
            groupId: message.aggregateId,
            deduplicationId: message.id,
          });
          await ctx.outbox.markPublished(message.id, now);
          metrics.increment('outbox.published');
          published += 1;
        } catch (error) {
          const delay = exponentialBackoffMs(message.attempts, config.backoffBaseMs, config.backoffMaxMs);
          // o domínio decide se ainda há tentativas ou se vira FAILED
          const next = message.markFailed(
            (error as Error).message,
            new Date(now.getTime() + delay),
            config.maxAttempts,
          );
          await ctx.outbox.markFailed(
            message.id,
            (error as Error).message,
            next.nextRetryAt,
            next.status === 'FAILED',
          );
          metrics.increment('outbox.failed');
          this.deps.logger.warn('Falha ao publicar evento', {
            transactionId: message.aggregateId,
            error: (error as Error).message,
          });
        }
      }
      return published;
    });
  }
}

export interface PendingRetryConfig {
  batchSize: number;
  intervalMs: number;
}

export const DEFAULT_PENDING_RETRY_CONFIG: PendingRetryConfig = {
  batchSize: 20,
  intervalMs: 2_000,
};

export class PendingReferenceRetryWorker extends IntervalWorker {
  constructor(
    private readonly deps: {
      uow: UnitOfWorkPort;
      processWager: ProcessWagerTransactionUseCase;
      clock: ClockPort;
      logger: LoggerPort;
      metrics: MetricsPort;
      config: PendingRetryConfig;
    },
  ) {
    super(deps.logger, 'pending-reference-retry', deps.config.intervalMs);
  }

  // Pega os vencidos e reavalia um a um; retryPending trava a carteira e relê o estado,
  // então duas instâncias disputando o mesmo id não duplicam efeito.
  async runOnce(): Promise<number> {
    const { uow, processWager, clock, logger, metrics, config } = this.deps;
    const ids = await uow.run((ctx) => ctx.transactions.claimDuePendingIds(clock.now(), config.batchSize));
    let handled = 0;
    for (const id of ids) {
      try {
        await processWager.retryPending(id);
        handled += 1;
        metrics.increment('pending_reference.retried');
      } catch (error) {
        logger.error('Falha ao reprocessar PENDING_REFERENCE', {
          transactionId: id,
          error: (error as Error).message,
        });
      }
    }
    return handled;
  }
}

