import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/config';
import { grantAppPrivileges } from '../src/infrastructure/persistence/grant-app-privileges';
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
  // no volume já migrado não há migration pendente, mas a role e os grants da app ainda precisam existir
  if (direction === 'up') {
    await grantAppPrivileges(orm.em.getConnection());
  }
  console.log(`${direction}: ${executed.map((m) => m.name).join(', ') || 'nothing to do'}`);
} finally {
  await orm.close();
}
