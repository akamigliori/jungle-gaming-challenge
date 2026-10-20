import { describe, expect, test } from 'bun:test';
import { ConnectionException } from '@mikro-orm/core';
import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
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
});
