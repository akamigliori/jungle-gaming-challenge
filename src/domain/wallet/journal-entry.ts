import { InvariantViolationError } from '../shared/domain-error';
import type { Money } from '../shared/money';
import type { LedgerDirection } from './ledger-direction';

export interface JournalEntryState {
  id: string;
  transactionId: string;
  accountId: string;
  direction: LedgerDirection;
  money: Money;
  createdAt: Date;
}

/** Contrapartida da casa numa partida dobrada: igual e oposta à entrada da wallet. */
export class JournalEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly accountId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly createdAt: Date;

  private constructor(s: JournalEntryState) {
    this.id = s.id;
    this.transactionId = s.transactionId;
    this.accountId = s.accountId;
    this.direction = s.direction;
    this.money = s.money;
    this.createdAt = s.createdAt;
  }

  static create(p: JournalEntryState): JournalEntry {
    if (!p.money.isPositive()) {
      throw new InvariantViolationError('journal entry money must be positive');
    }
    return new JournalEntry(p);
  }

  /** Reconstrói uma entrada persistida como está, sem validar. */
  static rehydrate(s: JournalEntryState): JournalEntry {
    return new JournalEntry(s);
  }

  /** Conta da casa no formato `house:{provider}:{currency}`. */
  static accountId(providerId: string, currency: string): string {
    return `house:${providerId}:${currency}`;
  }
}
