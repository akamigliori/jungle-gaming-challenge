import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normalizes to 2 decimals', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('007.50').toJSON().amount).toBe('7.50');
  });

  test('exact decimal arithmetic', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test.each([
    '',
    'abc',
    'NaN',
    'Infinity',
    '1e3',
    '-25.00',
    '+5',
    '25.',
    '.5',
    ' 25.00',
    '10.005',
    '1000000000000000000.00',
  ])('rejects %p with InvalidMoneyError', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('accepts the largest value that fits NUMERIC(20,2)', () => {
    expect(brl('999999999999999999.99').toJSON().amount).toBe('999999999999999999.99');
  });

  test('add beyond the NUMERIC(20,2) range throws InvalidMoneyError instead of a database error', () => {
    const max = brl('999999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => brl('500000000000000000.00').add(brl('500000000000000000.00'))).toThrow(
      InvalidMoneyError,
    );
    expect(max.add(brl('0.00')).toJSON().amount).toBe('999999999999999999.99');
  });

  test.each(['brl', 'BR', 'BRLL', ''])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('never rounds silently: 3 decimals is rejected, not rounded', () => {
    expect(() => brl('10.005')).toThrow(InvalidMoneyError);
    expect(() => brl('10.005')).toThrow(/scale/);
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('currency mismatch throws CurrencyMismatchError', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    const one = brl('1.00');
    expect(() => one.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => one.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => one.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => one.equals(usd)).toThrow(CurrencyMismatchError);
  });

  test('immutability: add returns a new instance, operands unchanged', () => {
    const a = brl('1.00');
    const b = brl('2.00');
    const sum = a.add(b);
    expect(sum).not.toBe(a);
    expect(sum).not.toBe(b);
    expect(a.toJSON().amount).toBe('1.00');
    expect(b.toJSON().amount).toBe('2.00');
  });

  test('negate/isNegative/isZero/isPositive; subtract may go negative internally', () => {
    expect(brl('1.00').subtract(brl('2.00')).toJSON().amount).toBe('-1.00');
    const neg = brl('1.00').negate();
    expect(neg.isNegative()).toBe(true);
    expect(neg.isPositive()).toBe(false);
    expect(neg.toJSON().amount).toBe('-1.00');
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('isLessThan and equals compare values', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.5').equals(brl('1.50'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });

  test('toString is "25.00 BRL"', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  test('zero("BRL").isZero()', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').currency).toBe('BRL');
  });
});
