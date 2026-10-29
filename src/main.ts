import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule, configureApp } from './app.module';
import { dataSource, runMigrations } from './infra/database/data-source';

async function bootstrap(): Promise<void> {
  await runMigrations(dataSource);

  // bun run migration:run só aplica as migrations e sai
  if (process.argv.includes('--migrate-only')) {
    await dataSource.destroy();
    return;
  }

  const app = await NestFactory.create(
    AppModule.register({
      dataSource,
      startWorkers: process.env['WORKERS_ENABLED'] !== 'false',
    }),
  );
  configureApp(app);
  // SIGTERM: para os workers e termina as requisições em andamento
  app.enableShutdownHooks();
  await app.listen(Number(process.env['PORT'] ?? 3000));
}

bootstrap().catch((error: unknown) => {
  console.error('Falha ao iniciar a aplicação', error);
  process.exit(1);
});

