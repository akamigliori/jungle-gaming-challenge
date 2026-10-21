import { CurrencyMismatchError, InvariantViolationError } from '../shared/domain-error';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { InsufficientFundsError, ReversalInsufficientFundsError } from './wallet-errors';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export type MovementInput = { money: Money; transactionId: string; entryId: string; at: Date };
export type DebitPurpose = 'WAGER' | 'REVERSAL';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.createdAt = state.createdAt;
    this._balance = state.balance;
    this._version = state.version;
    this._updatedAt = state.updatedAt;
  }

  static open(p: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } {
    if (p.initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance must not be negative');
    }
    const currency = p.initialBalance.currency;
    // A versão 0 é um estado interno de bootstrap: o crédito de abertura (ou o incremento explícito
    // abaixo) torna a versão 1 o primeiro estado observável da carteira.
    const wallet = new Wallet({
      id: p.id,
      playerId: p.playerId,
      currency,
      balance: Money.zero(currency),
      version: 0,
      createdAt: p.at,
      updatedAt: p.at,
    });
    if (p.initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet, openingEntry: null };
    }
    const openingEntry = wallet.apply(LedgerDirection.Credit, {
      money: p.initialBalance,
      transactionId: p.openingTransactionId,
      entryId: p.openingEntryId,
      at: p.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrói uma carteira persistida como está, sem validar. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(input: MovementInput, purpose: DebitPurpose = 'WAGER'): WalletLedgerEntry {
    this.assertSameCurrency(input.money);
    if (this._balance.isLessThan(input.money)) {
      const message = `insufficient funds: balance ${this._balance.toString()}, requested ${input.money.toString()}`;
      throw purpose === 'REVERSAL'
        ? new ReversalInsufficientFundsError(message)
        : new InsufficientFundsError(message);
    }
    return this.apply(LedgerDirection.Debit, input);
  }

  credit(input: MovementInput): WalletLedgerEntry {
    this.assertSameCurrency(input.money);
    return this.apply(LedgerDirection.Credit, input);
  }

  /** Constrói o lançamento primeiro, para que uma criação com falha deixe a carteira intacta. */
  private apply(direction: LedgerDirection, input: MovementInput): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(input.money)
        : this._balance.subtract(input.money);
    const entry = WalletLedgerEntry.create({
      id: input.entryId,
      walletId: this.id,
      transactionId: input.transactionId,
      direction,
      money: input.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: input.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = input.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `currency mismatch: wallet ${this.currency} vs ${money.currency}`,
      );
    }
  }
}
