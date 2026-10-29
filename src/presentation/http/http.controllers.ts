import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WagerTransactionStatus } from '../../domain/models/wager-transaction';
import { toTransactionView } from '../../application/dto/views';
import { parseWagerTransactionCommand } from '../../application/dto/wager-transaction-command';
import {
  CreateWalletUseCase,
  parseCreateWalletCommand,
} from '../../application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { QueriesUseCase } from '../../application/use-cases/queries.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { InMemoryMetrics } from '../../infra/observability/runtime-services';

interface StatusSetter {
  status(code: number): unknown;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(QueriesUseCase) private readonly queries: QueriesUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.createWallet.execute(parseCreateWalletCommand(body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    // limit inválido vira NaN e o use case responde 400
    return this.queries.getLedger(
      walletId,
      cursor ?? null,
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(walletId);
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(QueriesUseCase) private readonly queries: QueriesUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: StatusSetter,
  ) {
    const command = parseWagerTransactionCommand(body, {
      source: 'HTTP',
      idempotencyKey: idempotencyKey ?? null,
      correlationId: correlationId ?? null,
    });
    const { transaction, idempotentReplay } = await this.processWager.execute(command);

    // pendente: 202; rejeitada: 422; replay: 200; novo: 201
    if (transaction.status === WagerTransactionStatus.PENDING_REFERENCE) {
      res.status(202);
    } else if (transaction.status === WagerTransactionStatus.REJECTED) {
      res.status(422);
    } else {
      res.status(idempotentReplay ? 200 : 201);
    }
    return toTransactionView(transaction, idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getTransactionByProvider(providerId, externalTransactionId);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(InMemoryMetrics) private readonly metrics: InMemoryMetrics,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get()
  async health() {
    return this.ready();
  }

  // readiness: só o banco por enquanto (SQS não é verificado)
  @Get('ready')
  async ready() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'down', database: 'unreachable' });
    }
    return { status: 'ok', database: 'up' };
  }

  @Get('metrics')
  snapshot() {
    return this.metrics.snapshot();
  }
}

