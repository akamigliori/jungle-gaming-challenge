import type { FailureCode } from '../shared/failure-code';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import { InsufficientFundsError, ReversalInsufficientFundsError } from '../wallet/wallet-errors';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { DEFAULT_REFERENCE_RETRY, referenceRetryDelayMs } from './reference-retry';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as K } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

/** Transação referenciada, como o caso de uso a encontrou no banco. */
export interface ReferenceView {
  transaction: WagerTransaction;
  /** Já existe uma reversão PROCESSED apontando para ela. */
  alreadyReversed: boolean;
}

export type WagerDecision =
  | { outcome: 'PROCESSED'; entry: WalletLedgerEntry | null }
  | { outcome: 'REJECTED'; code: FailureCode }
  | { outcome: 'PENDING_REFERENCE'; referenceFound: boolean };

/** Tipos de transação que cada operação aceita como referência. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<K, K[]>> = {
  [K.Win]: [K.Bet],
  [K.Loss]: [K.Bet],
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
};

type ReferenceCheck =
  | { ok: true; referenceId: string | undefined }
  | { ok: false; decision: WagerDecision };

/**
 * Aplica as regras de negócio a uma transação nova, na ordem do desenho, e já muta `tx` e `wallet`.
 * Função pura: não acessa banco nem relógio; o chamador mantém a wallet travada e persiste o resultado.
 * `reference = null` significa "não encontrada"; é ignorada quando a transação não traz referência.
 */
export function decideWager(p: {
  tx: WagerTransaction;
  wallet: Wallet;
  reference: ReferenceView | null;
  at: Date;
  entryId: string;
}): WagerDecision {
  const { tx, wallet } = p;
  if (tx.playerId !== wallet.playerId) return reject(p, 'PLAYER_MISMATCH');
  // Saldo de outra moeda não é observável na moeda da transação: rejeita sem snapshot.
  if (tx.money.currency !== wallet.currency) return reject(p, 'CURRENCY_MISMATCH', false);

  const check = checkReference(p);
  if (!check.ok) return check.decision;

  if (!tx.affectsBalance()) {
    return processed(p, null, check.referenceId);
  }
  return applyMovement(p, check.referenceId);
}

function checkReference(p: {
  tx: WagerTransaction;
  wallet: Wallet;
  reference: ReferenceView | null;
  at: Date;
}): ReferenceCheck {
  const { tx, reference } = p;
  if (!hasReference(tx)) return { ok: true, referenceId: undefined };
  if (reference === null) return { ok: false, decision: pendingReference(p, false) };
  const failure = referenceFailure(tx, reference);
  if (failure === 'PENDING') return { ok: false, decision: pendingReference(p, true) };
  if (failure) return { ok: false, decision: reject(p, failure) };
  return { ok: true, referenceId: reference.transaction.id };
}

/**
 * Só a primeira vez agenda a espera; numa transação já pendente a decisão volta sem mutar,
 * e quem reagenda (contando a tentativa) é o chamador.
 */
function pendingReference(
  p: { tx: WagerTransaction; at: Date },
  referenceFound: boolean,
): WagerDecision {
  if (p.tx.status === WagerTransactionStatus.Pending) {
    const delayMs = referenceRetryDelayMs(0, DEFAULT_REFERENCE_RETRY);
    p.tx.markPendingReference({ nextAttemptAt: new Date(p.at.getTime() + delayMs) });
  }
  return { outcome: 'PENDING_REFERENCE', referenceFound };
}

/** WIN/LOSS só resolvem referência se ela foi informada; REFUND/ROLLBACK sempre a trazem. */
function hasReference(tx: WagerTransaction): boolean {
  return tx.referenceExternalTransactionId !== undefined;
}

/** Primeira regra de referência violada, na ordem: pertencimento, tipo, estado, reversão, valor. */
function referenceFailure(
  tx: WagerTransaction,
  reference: ReferenceView,
): FailureCode | 'PENDING' | null {
  const ref = reference.transaction;
  const sameOwner =
    ref.playerId === tx.playerId &&
    ref.walletId === tx.walletId &&
    ref.roundId === tx.roundId &&
    ref.money.currency === tx.money.currency;
  if (!sameOwner) return 'REFERENCE_MISMATCH';
  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(ref.kind)) return 'INVALID_REFERENCE_KIND';
  if (isUnresolved(ref)) return 'PENDING';
  if (ref.status !== WagerTransactionStatus.Processed) return 'REFERENCE_NOT_PROCESSED';
  if (reference.alreadyReversed) return 'ALREADY_REVERSED';
  if (isReversal(tx) && !ref.money.equals(tx.money)) return 'AMOUNT_MISMATCH';
  return null;
}

/** A referência ainda vai ser decidida: vale esperar. */
function isUnresolved(ref: WagerTransaction): boolean {
  return (
    ref.status === WagerTransactionStatus.Pending ||
    ref.status === WagerTransactionStatus.PendingReference
  );
}

function isReversal(tx: WagerTransaction): boolean {
  return tx.kind === K.Refund || tx.kind === K.Rollback;
}

function applyMovement(
  p: {
    tx: WagerTransaction;
    wallet: Wallet;
    reference: ReferenceView | null;
    at: Date;
    entryId: string;
  },
  referenceId: string | undefined,
): WagerDecision {
  const { tx, wallet, at } = p;
  const direction = tx.ledgerDirectionFor(p.reference?.transaction);
  const movement = { money: tx.money, transactionId: tx.id, entryId: p.entryId, at };
  try {
    const entry =
      direction === LedgerDirection.Credit
        ? wallet.credit(movement)
        : wallet.debit(movement, isReversal(tx) ? 'REVERSAL' : 'WAGER');
    return processed(p, entry, referenceId);
  } catch (error) {
    if (error instanceof ReversalInsufficientFundsError) {
      return reject(p, 'REVERSAL_INSUFFICIENT_FUNDS');
    }
    if (error instanceof InsufficientFundsError) return reject(p, 'INSUFFICIENT_FUNDS');
    throw error;
  }
}

function processed(
  p: { tx: WagerTransaction; wallet: Wallet; at: Date },
  entry: WalletLedgerEntry | null,
  referenceTransactionId: string | undefined,
): WagerDecision {
  p.tx.markProcessed({
    referenceTransactionId,
    at: p.at,
    balanceAfter: p.wallet.balance,
    walletVersionAfter: p.wallet.version,
  });
  return { outcome: 'PROCESSED', entry };
}

function reject(
  p: { tx: WagerTransaction; wallet: Wallet; at: Date },
  code: FailureCode,
  observeBalance = true,
): WagerDecision {
  p.tx.reject(
    code,
    p.at,
    observeBalance
      ? { balanceAfter: p.wallet.balance, walletVersionAfter: p.wallet.version }
      : undefined,
  );
  return { outcome: 'REJECTED', code };
}
