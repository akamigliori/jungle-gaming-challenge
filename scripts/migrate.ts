import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/config';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig(loadConfig()));
try {
  const migrator = orm.getMigrator();
  const executed = direction === 'up' ? await migrator.up() : await migrator.down();
  console.log(`${direction}: ${executed.map((m) => m.name).join(', ') || 'nothing to do'}`);
} finally {
  await orm.close();
}
