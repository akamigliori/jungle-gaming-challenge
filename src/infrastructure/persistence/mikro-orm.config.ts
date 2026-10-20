import { join } from 'node:path';
import { Migrator } from '@mikro-orm/migrations';
import type { Options } from '@mikro-orm/postgresql';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/config';

/** Tempo máximo para abrir uma conexão com o Postgres: falha rápido em vez de travar. */
const CONNECTION_TIMEOUT_MS = 1500;

/** Configuração do MikroORM: entidades de persistência e Migrator. */
export function createOrmConfig(cfg: AppConfig): Options {
  return {
    driver: PostgreSqlDriver,
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    dbName: cfg.db.name,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    forceUtcTimezone: true,
    driverOptions: { connection: { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS } },
    migrations: {
      path: join(import.meta.dir, 'migrations'),
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  };
}
