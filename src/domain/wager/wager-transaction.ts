import { InvalidMoneyError, InvariantViolationError } from '../shared/domain-error';
import type { FailureCode } from '../shared/failure-code';
import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import {
  InvalidTransactionStateError,
  ReferenceNotAllowedError,
  ReferenceRequiredError,
} from './wager-errors';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

const S = WagerTransactionStatus;

/** Valores fixos da transação interna de abertura (também entram no hash do payload). */
export const OPENING_PROVIDER_ID = 'internal';
export const OPENING_ROUND_ID = 'opening';
export const OPENING_GAME_ID = 'internal';

/** Transições válidas. PROCESSED, REJECTED e FAILED são estados terminais. */
const ALLOWED: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  [S.Pending]: [S.Processed, S.Rejected, S.Failed, S.PendingReference],
  [S.PendingReference]: [S.Processed, S.Rejected, S.Failed],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor, não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money;
  walletVersionAfter?: number;
  /** Quantas vezes a referência já foi reavaliada sem sucesso. */
  referenceAttempts: number;
  /** Quando o worker deve tentar resolver a referência de novo (só em PENDING_REFERENCE). */
  nextReferenceAttemptAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _balanceAfter: Money | undefined;
  private _walletVersionAfter: number | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
    this._balanceAfter = s.balanceAfter;
    this._walletVersionAfter = s.walletVersionAfter;
    this._referenceAttempts = s.referenceAttempts;
    this._nextReferenceAttemptAt = s.nextReferenceAttemptAt;
  }

  /** Começa em PENDING. Valida a exigência de referência por tipo. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening) {
      throw new InvariantViolationError('OPENING transactions are internal; use opening()');
    }
    if (!p.money.isPositive()) {
      throw new InvalidMoneyError('transaction amount must be positive');
    }
    const hasReference = p.referenceExternalTransactionId !== undefined;
    if (
      (p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback) &&
      !hasReference
    ) {
      throw new ReferenceRequiredError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (p.kind === WagerTransactionKind.Bet && hasReference) {
      throw new ReferenceNotAllowedError('BET must not carry a reference');
    }
    return new WagerTransaction({ ...p, status: S.Pending, referenceAttempts: 0 });
  }

  /** Crédito interno de abertura da carteira. O chamador calcula o hash (o domínio não tem criptografia). */
  static opening(p: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    return new WagerTransaction({
      id: p.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: p.walletId,
      idempotencyKey: `opening:${p.walletId}`,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: p.money,
      createdAt: p.at,
      status: S.Pending,
      referenceAttempts: 0,
    });
  }

  /** Reconstrói uma transação persistida como está, sem validar. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get walletVersionAfter(): number | undefined {
    return this._walletVersionAfter;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(p: {
    referenceTransactionId?: string;
    at: Date;
    balanceAfter: Money;
    walletVersionAfter: number;
  }): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = p.referenceTransactionId;
    this._processedAt = p.at;
    this._balanceAfter = p.balanceAfter;
    this._walletVersionAfter = p.walletVersionAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  /** A referência ainda não chegou: fica pendente até `nextAttemptAt`. */
  markPendingReference(p: { nextAttemptAt: Date }): void {
    this.transitionTo(S.PendingReference);
    this._nextReferenceAttemptAt = p.nextAttemptAt;
  }

  /** A referência continua ausente: conta a tentativa e reagenda, sem mudar de estado. */
  retryReferenceLater(nextAttemptAt: Date): void {
    if (this._status !== S.PendingReference) {
      throw new InvalidTransactionStateError(`cannot retry reference from ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(
    code: FailureCode,
    at: Date,
    observed?: { balanceAfter: Money; walletVersionAfter: number },
  ): void {
    this.transitionTo(S.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = observed?.balanceAfter;
    this._walletVersionAfter = observed?.walletVersionAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(S.Failed);
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return ALLOWED[this._status].length === 0;
  }

  /** LOSS é registrado, mas nunca movimenta dinheiro. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK needs its reference to derive direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not generate a ledger entry');
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`invalid transition ${this._status} -> ${next}`);
    }
    this._status = next;
  }
}
