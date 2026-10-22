import { describe, expect, test } from 'bun:test';
import { ConnectionException } from '@mikro-orm/core';
import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { TransientFailureError } from '../../../src/application/shared/retry-transient';
import {
  DomainError,
  InvalidMoneyError,
  InvariantViolationError,
} from '../../../src/domain/shared/domain-error';
import { InsufficientFundsError } from '../../../src/domain/wallet/wallet-errors';
import { HttpErrorFilter } from '../../../src/interfaces/http/http-error.filter';

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  logs: { level: string; obj: unknown }[];
}

function run(error: unknown): Captured {
  const c: Captured = { headers: {}, logs: [] };
  const logger = {
    info: (obj: unknown) => c.logs.push({ level: 'info', obj }),
    warn: (obj: unknown) => c.logs.push({ level: 'warn', obj }),
    error: (obj: unknown) => c.logs.push({ level: 'error', obj }),
  };
  const res = {
    status(s: number) {
      c.status = s;
      return this;
    },
    setHeader(k: string, v: string) {
      c.headers[k] = v;
    },
    json(b: unknown) {
      c.body = b;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new HttpErrorFilter(logger).catch(error, host);
  return c;
}

describe('HttpErrorFilter', () => {
  test('DomainError → mapped status with uniform body', () => {
    const c = run(new InsufficientFundsError('insufficient funds'));
    expect(c.status).toBe(422);
    expect(c.body).toEqual({
      error: { code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds', retryable: false },
    });
  });

  test('DomainError mapped to 5xx never echoes its message', () => {
    class BrokenDependencyError extends DomainError {
      readonly code = 'INTERNAL_ERROR' as const;
    }
    const c = run(new BrokenDependencyError('secret connection detail'));
    expect(c.status).toBe(500);
    expect(c.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: false },
    });
  });

  test('invalid money → 400', () => {
    expect(run(new InvalidMoneyError('bad amount')).status).toBe(400);
  });

  test('ZodError → 400 INVALID_PAYLOAD', () => {
    const r = z.object({ playerId: z.uuid() }).safeParse({ playerId: 'x' });
    const c = run(r.error);
    expect(c.status).toBe(400);
    expect((c.body as { error: { code: string } }).error.code).toBe('INVALID_PAYLOAD');
  });

  test('BadRequestException (malformed JSON) → 400 INVALID_PAYLOAD', () => {
    const c = run(new BadRequestException('Unexpected token'));
    expect(c.status).toBe(400);
    expect((c.body as { error: { code: string } }).error.code).toBe('INVALID_PAYLOAD');
  });

  /** Erro no formato do pacote `http-errors`, usado pelo body-parser do Express. */
  const bodyParserError = (message: string, status: number, type: string) =>
    Object.assign(new Error(message), { status, statusCode: status, expose: true, type });

  test.each([
    ['request entity too large', 413, 'entity.too.large'],
    ['unsupported content encoding "bogus"', 415, 'encoding.unsupported'],
    ['request aborted', 400, 'request.aborted'],
  ])('body-parser error %p → %i INVALID_PAYLOAD', (message, status, type) => {
    const c = run(bodyParserError(message, status, type));
    expect(c.status).toBe(status);
    expect(c.body).toEqual({ error: { code: 'INVALID_PAYLOAD', message, retryable: false } });
  });

  test('raw SyntaxError with status 400 (body-parser) → 400 INVALID_PAYLOAD', () => {
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      status: 400,
      expose: true,
    });
    expect(run(err).status).toBe(400);
    expect((run(err).body as { error: { code: string } }).error.code).toBe('INVALID_PAYLOAD');
  });

  test('error with 5xx or non-exposed status stays 500', () => {
    expect(run(Object.assign(new Error('x'), { status: 503, expose: false })).status).toBe(500);
    expect(run(Object.assign(new Error('x'), { status: 400 })).status).toBe(500);
  });

  test('HttpException 503 → generic unavailable message, not the original one', () => {
    const c = run(new HttpException('db password leaked', 503));
    expect(c.status).toBe(503);
    expect((c.body as { error: { message: string } }).error.message).toBe(
      'Service temporarily unavailable',
    );
  });

  test('NotFoundException → 404 NOT_FOUND', () => {
    const c = run(new NotFoundException('Cannot GET /nope'));
    expect(c.status).toBe(404);
    expect((c.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  test('database connection error → 503 retryable with Retry-After', () => {
    const c = run(new ConnectionException(new Error('connect ECONNREFUSED 127.0.0.1:5433')));
    expect(c.status).toBe(503);
    expect(c.headers['Retry-After']).toBeDefined();
    expect(c.body).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable',
        retryable: true,
      },
    });
  });

  test('TransientFailureError → 503 with Retry-After, without echoing the cause', () => {
    const c = run(new TransientFailureError(new Error('canceling statement due to lock timeout')));
    expect(c.status).toBe(503);
    expect(c.headers['Retry-After']).toBeDefined();
    expect(c.body).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable',
        retryable: true,
      },
    });
  });

  test('raw ECONNREFUSED → 503', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(run(err).status).toBe(503);
  });

  test('unknown error → 500 without leaking details, logged at error level', () => {
    const c = run(new InvariantViolationError('secret internal detail'));
    expect(c.status).toBe(500);
    expect(c.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: false },
    });
    expect(JSON.stringify(c.body)).not.toContain('secret');
    expect(c.logs.map((l) => l.level)).toEqual(['error']);
  });

  test('4xx is logged below error level', () => {
    const c = run(new InsufficientFundsError('insufficient funds'));
    expect(c.logs).toHaveLength(1);
    expect(c.logs[0]?.level).not.toBe('error');
  });

  test('5xx log keeps only safe driver fields, never the query or its values', () => {
    const driver = Object.assign(
      new Error(
        "INSERT INTO wallets (player_id, balance) VALUES ('player-secret', '123.45') - new row violates check constraint",
      ),
      { code: '23514', constraint: 'wallets_balance_non_negative', table: 'wallets' },
    );
    const c = run(new TransientFailureError(driver));

    expect(c.status).toBeGreaterThanOrEqual(500);
    const logged = JSON.stringify(c.logs[0]?.obj);
    expect(logged).toContain('23514');
    expect(logged).toContain('wallets_balance_non_negative');
    expect(logged).not.toContain('player-secret');
    expect(logged).not.toContain('123.45');
  });
});
