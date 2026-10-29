import { DataSource } from 'typeorm';
import { InitialSchema1730000000000 } from './migrations/1730000000000-initial-schema';

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/wagering';

export function createDataSource(url: string = process.env['DATABASE_URL'] ?? DEFAULT_URL): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    migrations: [InitialSchema1730000000000],
    // SQL é explícito no postgres-uow.ts, então não há entities
    entities: [],
    synchronize: false,
  });
}

export const dataSource = createDataSource();

export async function runMigrations(ds: DataSource): Promise<void> {
  if (!ds.isInitialized) {
    await ds.initialize();
  }
  await ds.runMigrations();
}

