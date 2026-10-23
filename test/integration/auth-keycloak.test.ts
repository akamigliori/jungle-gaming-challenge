import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';

/**
 * Smoke test contra o Keycloak real (profile `auth` do Compose). Só roda quando a suíte é
 * invocada com `KEYCLOAK_AUTH_TEST=true`; confirma que o realm emite `azp` (o client id) e o
 * `scope` esperados para o `client_credentials`.
 */
const ENABLED = process.env.KEYCLOAK_AUTH_TEST === 'true';
const ISSUER = 'http://localhost:8080/realms/wagering';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let orm: MikroORM;
let t: TestApp;

async function clientToken(clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function send(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: { code: string } } & object };
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp({
    AUTH_ENABLED: 'true',
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: 'wagering-app',
    OIDC_JWKS_URI: `${ISSUER}/protocol/openid-connect/certs`,
  });
});

afterAll(async () => {
  await t.close();
  await orm.close();
});

beforeEach(async () => {
  await resetDb(orm);
});

describe.skipIf(!ENABLED)('Keycloak real', () => {
  test('token de client_credentials autentica e submete a aposta', async () => {
    const backoffice = await clientToken('backoffice', 'backoffice-secret');
    const created = await send(
      'POST',
      '/wallets',
      { playerId: PLAYER_ID, initialBalance: { amount: '100.00', currency: 'BRL' } },
      backoffice,
    );
    expect(created.status).toBe(201);
    const walletId = (created.body as { id: string }).id;

    const providerA = await clientToken('provider-a', 'provider-a-secret');
    const submitted = await send(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: 'keycloak-bet-1',
        playerId: PLAYER_ID,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      providerA,
      { 'idempotency-key': 'provider-a:keycloak-bet-1' },
    );
    expect(submitted.status).toBe(201);
  });

  test('provider do token diferente do corpo → 403', async () => {
    const backoffice = await clientToken('backoffice', 'backoffice-secret');
    const created = await send(
      'POST',
      '/wallets',
      { playerId: PLAYER_ID, initialBalance: { amount: '100.00', currency: 'BRL' } },
      backoffice,
    );
    const walletId = (created.body as { id: string }).id;

    const providerA = await clientToken('provider-a', 'provider-a-secret');
    const res = await send(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-b',
        externalTransactionId: 'keycloak-bet-2',
        playerId: PLAYER_ID,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      providerA,
      { 'idempotency-key': 'provider-a:keycloak-bet-2' },
    );
    expect(res.status).toBe(403);
  });
});
