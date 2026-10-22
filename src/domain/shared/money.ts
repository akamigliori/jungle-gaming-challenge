import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Cabe em NUMERIC(20,2): 18 dígitos inteiros + 2 casas decimais. */
const MAX_INTEGER_DIGITS = 18;
const SCALE = 2;
const MAX_EXCLUSIVE = new MoneyDecimal(10).pow(MAX_INTEGER_DIGITS);

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be 3 uppercase letters');
    }
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount must be a non-negative decimal string with at most ${SCALE} decimal places (scale)`,
      );
    }
    const integerPart = amount.split('.')[0] ?? '';
    if (integerPart.replace(/^0+(?=\d)/, '').length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount must have at most ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const sum = this.value.plus(other.value);
    // estouro de NUMERIC(20,2) vira erro de domínio, nunca erro de banco
    if (sum.abs().greaterThanOrEqualTo(MAX_EXCLUSIVE)) {
      throw new InvalidMoneyError(`amount must have at most ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(sum, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
