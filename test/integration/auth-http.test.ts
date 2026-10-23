import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';

const ISSUER = 'http://localhost:8080/realms/wagering';
const AUDIENCE = 'wagering-app';
const KID = 'auth-test-kid';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let orm: MikroORM;
let t: TestApp;
let signer: (payload: Record<string, unknown>) => Promise<string>;
let closeJwks: () => void;

function token(providerId: string, scopes: string): Promise<string> {
  return signer({ azp: providerId, scope: scopes });
}

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: { code: string } } & object };
}

async function createWallet(): Promise<string> {
  const auth = await token('backoffice', 'wallets:manage');
  const res = await send(
    'POST',
    '/wallets',
    { playerId: PLAYER_ID, initialBalance: { amount: '100.00', currency: 'BRL' } },
    { authorization: `Bearer ${auth}` },
  );
  return (res.body as { id: string }).id;
}

function wagerBody(walletId: string, providerId = 'provider-a') {
  return {
    providerId,
    externalTransactionId: 'bet-1',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
}

beforeAll(async () => {
  orm = await withTestDb();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...publicJwk, alg: 'RS256', kid: KID }] };
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } }),
  });
  closeJwks = () => server.stop(true);

  signer = (payload) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  t = await createTestApp({
    AUTH_ENABLED: 'true',
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URI: `http://localhost:${server.port}/jwks`,
  });
});

afterAll(async () => {
  await t.close();
  await orm.close();
  closeJwks();
});

beforeEach(async () => {
  await resetDb(orm);
});

describe('autenticação HTTP', () => {
  test('sem token → 401 UNAUTHORIZED', async () => {
    const res = await send('POST', '/wagering/transactions', wagerBody('qualquer'));
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  test('escopo errado → 403 FORBIDDEN', async () => {
    const walletId = await createWallet();
    const auth = await token('provider-a', 'wagers:read');
    const res = await send('POST', '/wagering/transactions', wagerBody(walletId), {
      authorization: `Bearer ${auth}`,
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  test('providerId do corpo diferente do token → 403 FORBIDDEN', async () => {
    const walletId = await createWallet();
    const auth = await token('provider-a', 'wagers:submit');
    const res = await send('POST', '/wagering/transactions', wagerBody(walletId, 'provider-b'), {
      authorization: `Bearer ${auth}`,
      'idempotency-key': 'provider-a:bet-1',
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  test('token válido e provider certo → 201', async () => {
    const walletId = await createWallet();
    const auth = await token('provider-a', 'wagers:submit');
    const res = await send('POST', '/wagering/transactions', wagerBody(walletId), {
      authorization: `Bearer ${auth}`,
      'idempotency-key': 'provider-a:bet-1',
    });
    expect(res.status).toBe(201);
  });

  test('GET de transação de outro provedor → 404 sem revelar que existe', async () => {
    const walletId = await createWallet();
    const submitAuth = await token('provider-a', 'wagers:submit');
    const submitted = await send('POST', '/wagering/transactions', wagerBody(walletId), {
      authorization: `Bearer ${submitAuth}`,
      'idempotency-key': 'provider-a:bet-1',
    });
    const transactionId = (submitted.body as { transactionId: string }).transactionId;

    const readAuth = await token('provider-b', 'wagers:read');
    const res = await send('GET', `/wagering/transactions/${transactionId}`, undefined, {
      authorization: `Bearer ${readAuth}`,
    });
    expect(res.status).toBe(404);
  });
});
