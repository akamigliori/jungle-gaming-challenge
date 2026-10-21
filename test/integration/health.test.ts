import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestApp, type TestApp } from './support/app';

describe('health', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  test('live → 200 without auth header', async () => {
    const res = await fetch(`${t.baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('ready → 200 with postgres up and sqs up', async () => {
    const res = await fetch(`${t.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('response echoes x-correlation-id', async () => {
    const res = await fetch(`${t.baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'test-correlation-1' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('test-correlation-1');
  });

  test('generates x-correlation-id when absent', async () => {
    const res = await fetch(`${t.baseUrl}/health/live`);
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('unknown route → 404 with uniform error body', async () => {
    const res = await fetch(`${t.baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.retryable).toBe(false);
  });
});

describe('health with unreachable dependencies', () => {
  test('ready → 503 within 3s when SQS endpoint is unreachable', async () => {
    const t = await createTestApp({ SQS_ENDPOINT: 'http://127.0.0.1:1' });
    try {
      const started = Date.now();
      const res = await fetch(`${t.baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; checks: Record<string, string> };
      expect(body).toEqual({ status: 'error', checks: { postgres: 'up', sqs: 'down' } });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await t.close();
    }
  });

  test.each([
    ['SQS', 'SQS_ENDPOINT', (port: number) => `http://127.0.0.1:${port}`],
    ['Postgres', 'DB_PORT', (port: number) => String(port)],
  ] as const)('ready → 503 within 3s when %s accepts but never answers', async (_, key, value) => {
    // servidor TCP que aceita a conexão e nunca responde: só o timeout encerra a verificação
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const t = await createTestApp({ [key]: value(silent.port), DB_HOST: '127.0.0.1' });
    try {
      const started = Date.now();
      const res = await fetch(`${t.baseUrl}/health/ready`);
      const elapsed = Date.now() - started;
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: { postgres: string; sqs: string } };
      expect(key === 'DB_PORT' ? body.checks.postgres : body.checks.sqs).toBe('down');
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await t.close();
      silent.stop(true);
    }
  });

  test('ready → 503 within 3s when Postgres is unreachable', async () => {
    const t = await createTestApp({ DB_PORT: '1' });
    try {
      const started = Date.now();
      const res = await fetch(`${t.baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: Record<string, string> };
      expect(body.checks).toEqual({ postgres: 'down', sqs: 'up' });
      expect(Date.now() - started).toBeLessThan(3000);
      // liveness não depende das dependências externas
      expect((await fetch(`${t.baseUrl}/health/live`)).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});
