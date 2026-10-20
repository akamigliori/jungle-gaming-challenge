import { CurrencyMismatchError, InvariantViolationError } from '../shared/domain-error';
import type { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Registro imutável e somente de inserção de uma movimentação de saldo. */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = state.createdAt;
  }

  static create(p: CreateLedgerEntryProps): WalletLedgerEntry {
    if (
      p.money.currency !== p.balanceBefore.currency ||
      p.money.currency !== p.balanceAfter.currency
    ) {
      throw new CurrencyMismatchError('ledger entry amounts must share the same currency');
    }
    if (!p.money.isPositive()) {
      throw new InvariantViolationError('ledger entry money must be positive');
    }
    if (p.balanceBefore.isNegative() || p.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry balances must not be negative');
    }
    const entry = new WalletLedgerEntry(p);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('ledger entry is unbalanced');
    }
    return entry;
  }

  /** Reconstrói um lançamento persistido como está, sem validar. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
