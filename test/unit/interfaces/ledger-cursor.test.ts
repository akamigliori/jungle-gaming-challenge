import { describe, expect, test } from 'bun:test';
import { InvalidPayloadError } from '../../../src/domain/shared/domain-error';
import { decodeCursor, encodeCursor } from '../../../src/interfaces/http/wallets/ledger-cursor';

describe('ledger cursor', () => {
  test.each([1, 2, 50, 123_456])('round-trip encode/decode %i', (version) => {
    const cursor = encodeCursor(version);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe(version);
  });

  test.each([
    '%%%',
    '',
    'YWJj' /* "abc" */,
    'LTE' /* "-1" */,
    'MA' /* "0" */,
    'MDE' /* "01" */,
    'MS41' /* "1.5" */,
  ])('decode %p throws InvalidPayloadError', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidPayloadError);
  });
});
