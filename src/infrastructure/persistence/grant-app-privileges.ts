/**
 * Papel da aplicação em runtime: só DML, sem DDL nem `TRUNCATE`. As migrations continuam rodando
 * como o dono do banco (`wagering`), que cria as tabelas e é quem executa este script.
 *
 * O papel é criado aqui (e não num script de init do Postgres) porque os scripts de init só rodam
 * com o volume vazio; num volume já migrado, este passo após `migrate up` garante a role e os
 * grants. É idempotente: pode rodar quantas vezes for preciso.
 */
const DEFAULT_APP_ROLE = 'wagering_app';
const DEFAULT_APP_PASSWORD = 'wagering_app';

/** Tabelas em que a app lê e escreve; só a outbox recebe `DELETE` (retenção). */
const APP_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'journal_entries',
  'inbox_messages',
  'outbox_messages',
] as const;

/** Tabela da app onde o worker de retenção apaga eventos publicados. */
const OUTBOX_TABLE = 'outbox_messages';

/** Subconjunto de `Connection` do MikroORM usado aqui (só `execute` de SQL). */
export interface SqlExecutor {
  execute(query: string, params?: unknown[], method?: string): Promise<unknown>;
}

/** Aspas de identificador, para escapar nomes de papel/tabela. */
const ident = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Aspas de literal, para a senha da role. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Cria o papel DML-only (se ainda não existir) e aplica os grants: `SELECT, INSERT, UPDATE` nas
 * tabelas da app, `DELETE` só na outbox, `USAGE` no schema e `CONNECT` no banco. Também deixa os
 * privilégios padrão para tabelas que migrations futuras criarem.
 */
export async function grantAppPrivileges(
  connection: SqlExecutor,
  role = process.env.DB_APP_USER ?? DEFAULT_APP_ROLE,
  password = process.env.DB_APP_PASSWORD ?? DEFAULT_APP_PASSWORD,
): Promise<void> {
  const app = ident(role);

  await connection.execute(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
        CREATE ROLE ${app} LOGIN PASSWORD ${literal(password)};
      END IF;
    END
    $$`);

  // o nome do banco vem do servidor; `format` cuida das aspas
  await connection.execute(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${literal(role)});
    END
    $$`);

  await connection.execute(`GRANT USAGE ON SCHEMA public TO ${app}`);

  // migrations futuras (rodando como o dono atual) já nascem com os grants
  await connection.execute(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${app}`,
  );
  await connection.execute(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
  );

  await connection.execute(
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${APP_TABLES.map(ident).join(', ')} TO ${app}`,
  );
  await connection.execute(`GRANT DELETE ON TABLE ${ident(OUTBOX_TABLE)} TO ${app}`);
}
