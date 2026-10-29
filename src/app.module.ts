import 'reflect-metadata';
import { Inject, Injectable, Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { QueriesUseCase } from './application/use-cases/queries.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { dataSource as defaultDataSource } from './infra/database/data-source';
import { PostgresUnitOfWork } from './infra/database/postgres-uow';
import {
  AwsSqsClient,
  DEFAULT_CONSUMER_CONFIG,
  DEFAULT_OUTBOX_CONFIG,
  DEFAULT_PENDING_RETRY_CONFIG,
  OutboxPublisherWorker,
  PendingReferenceRetryWorker,
  SqsConsumerWorker,
  type SqsClientPort,
} from './infra/messaging/workers';
import {
  CryptoIdGenerator,
  InMemoryMetrics,
  StructuredJsonLogger,
  SystemClock,
} from './infra/observability/runtime-services';
import { AllExceptionsFilter } from './presentation/http/all-exceptions.filter';
import {
  HealthController,
  WageringController,
  WalletsController,
} from './presentation/http/http.controllers';

const SQS = 'SQS_CLIENT';
const UOW = 'UNIT_OF_WORK';

export interface AppOptions {
  dataSource?: DataSource | undefined;
  sqs?: SqsClientPort | undefined;
  /** Liga os workers de background (consumer, outbox, retry). Desligado nos testes. */
  startWorkers?: boolean | undefined;
}

const queueBase = 'http://localhost:4566/000000000000';

// sobe e para os workers junto com a aplicação (SIGTERM via enableShutdownHooks)
@Injectable()
class WorkersRunner {
  private readonly workers: { start(): void; stop(): Promise<void> }[];

  constructor(
    @Inject(SqsConsumerWorker) consumer: SqsConsumerWorker,
    @Inject(OutboxPublisherWorker) outbox: OutboxPublisherWorker,
    @Inject(PendingReferenceRetryWorker) pending: PendingReferenceRetryWorker,
    @Inject('START_WORKERS') private readonly enabled: boolean,
  ) {
    this.workers = [consumer, outbox, pending];
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.workers.forEach((w) => w.start());
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.stop()));
  }
}

@Module({})
export class AppModule {
  static register(options: AppOptions = {}): DynamicModule {
    const env = process.env;
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        {
          provide: DataSource,
          useFactory: async () => {
            const ds = options.dataSource ?? defaultDataSource;
            if (!ds.isInitialized) await ds.initialize();
            return ds;
          },
        },
        { provide: SQS, useFactory: () => options.sqs ?? new AwsSqsClient() },
        { provide: 'START_WORKERS', useValue: options.startWorkers ?? false },
        SystemClock,
        CryptoIdGenerator,
        StructuredJsonLogger,
        InMemoryMetrics,
        { provide: UOW, useFactory: (ds: DataSource) => new PostgresUnitOfWork(ds), inject: [DataSource] },
        {
          provide: CreateWalletUseCase,
          useFactory: (uow: PostgresUnitOfWork, clock: SystemClock, ids: CryptoIdGenerator) =>
            new CreateWalletUseCase({ uow, clock, ids }),
          inject: [UOW, SystemClock, CryptoIdGenerator],
        },
        {
          provide: ProcessWagerTransactionUseCase,
          useFactory: (
            uow: PostgresUnitOfWork,
            clock: SystemClock,
            ids: CryptoIdGenerator,
            logger: StructuredJsonLogger,
            metrics: InMemoryMetrics,
          ) => new ProcessWagerTransactionUseCase({ uow, clock, ids, logger, metrics }),
          inject: [UOW, SystemClock, CryptoIdGenerator, StructuredJsonLogger, InMemoryMetrics],
        },
        {
          provide: QueriesUseCase,
          useFactory: (uow: PostgresUnitOfWork) => new QueriesUseCase({ uow }),
          inject: [UOW],
        },
        {
          provide: ReconcileWalletUseCase,
          useFactory: (
            uow: PostgresUnitOfWork,
            clock: SystemClock,
            logger: StructuredJsonLogger,
            metrics: InMemoryMetrics,
          ) => new ReconcileWalletUseCase({ uow, clock, logger, metrics }),
          inject: [UOW, SystemClock, StructuredJsonLogger, InMemoryMetrics],
        },
        {
          provide: SqsConsumerWorker,
          useFactory: (
            sqs: SqsClientPort,
            processWager: ProcessWagerTransactionUseCase,
            logger: StructuredJsonLogger,
            metrics: InMemoryMetrics,
          ) =>
            new SqsConsumerWorker({
              sqs,
              processWager,
              logger,
              metrics,
              config: {
                ...DEFAULT_CONSUMER_CONFIG,
                queueUrl: env['SQS_WAGER_QUEUE_URL'] ?? `${queueBase}/wager-transactions.fifo`,
                dlqUrl: env['SQS_WAGER_DLQ_URL'],
              },
            }),
          inject: [SQS, ProcessWagerTransactionUseCase, StructuredJsonLogger, InMemoryMetrics],
        },
        {
          provide: OutboxPublisherWorker,
          useFactory: (
            uow: PostgresUnitOfWork,
            sqs: SqsClientPort,
            clock: SystemClock,
            logger: StructuredJsonLogger,
            metrics: InMemoryMetrics,
          ) =>
            new OutboxPublisherWorker({
              uow,
              sqs,
              clock,
              logger,
              metrics,
              config: {
                ...DEFAULT_OUTBOX_CONFIG,
                eventsQueueUrl: env['SQS_EVENTS_QUEUE_URL'] ?? `${queueBase}/wager-events.fifo`,
              },
            }),
          inject: [UOW, SQS, SystemClock, StructuredJsonLogger, InMemoryMetrics],
        },
        {
          provide: PendingReferenceRetryWorker,
          useFactory: (
            uow: PostgresUnitOfWork,
            processWager: ProcessWagerTransactionUseCase,
            clock: SystemClock,
            logger: StructuredJsonLogger,
            metrics: InMemoryMetrics,
          ) =>
            new PendingReferenceRetryWorker({
              uow,
              processWager,
              clock,
              logger,
              metrics,
              config: DEFAULT_PENDING_RETRY_CONFIG,
            }),
          inject: [UOW, ProcessWagerTransactionUseCase, SystemClock, StructuredJsonLogger, InMemoryMetrics],
        },
        WorkersRunner,
      ],
    };
  }
}

/** Filtro global de erros; usado no main e nos testes. */
export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new AllExceptionsFilter(app.get(StructuredJsonLogger)));
}

/** Sobe o módulo para testes de integração, com DataSource e SQS opcionais; workers desligados. */
export async function createTestingApp(
  customDataSource?: DataSource,
  customSqs?: SqsClientPort,
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule.register({ dataSource: customDataSource, sqs: customSqs, startWorkers: false }),
    { logger: false },
  );
  configureApp(app);
  await app.init();
  return app;
}

