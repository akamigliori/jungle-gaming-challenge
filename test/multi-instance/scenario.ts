import { Money } from '../../src/domain/shared/money';

export const PROVIDER_ID = 'provider-multi';
export const CURRENCY = 'BRL';
/** Saldo inicial alto o bastante para nenhuma operação do roteiro ser recusada por saldo. */
export const INITIAL_BALANCE = '1000.00';
export const ROUNDS_PER_WALLET = 13;
/** Corpo que não é JSON: vai direto para a DLQ como `INVALID_PAYLOAD`. */
export const POISON_BODY = '{"messageId": "poison", not json';
const POISON_GROUP_ID = 'poison';
const HTTP_BET_AMOUNT = '25.00';
const OCCURRED_AT = '2026-10-22T12:00:00.000Z';
const MESSAGE_TYPE = 'WagerTransactionRequested';
/** Posições, no roteiro de cada wallet, da reentrega e da mensagem que repete uma operação. */
const REDELIVERED_INDEX = 2;
const REDELIVERY_POSITION = 6;
const DUPLICATED_OPERATION_POSITION = 10;

export interface ScenarioWallet {
  id: string;
  playerId: string;
}

export interface ScriptedMessage {
  body: unknown;
  /** `MessageGroupId`: a wallet (ordem FIFO por wallet), ou um grupo próprio para a venenosa. */
  groupId: string;
  dedupId: string;
}

/** A mesma `BET` enviada várias vezes por HTTP, com a mesma chave de idempotência. */
export interface HttpBet {
  walletId: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
}

export interface Scenario {
  /** Em ordem de envio dentro de cada `groupId`. */
  messages: ScriptedMessage[];
  /** Saldo final de cada wallet, calculado pelo roteiro (inclui a `BET` via HTTP). */
  expectedBalance: Map<string, string>;
  /** `messageId` distintos das mensagens válidas: uma linha de inbox para cada. */
  validMessageIds: Set<string>;
  /** Operações distintas do roteiro (SQS + HTTP); todas terminam `PROCESSED`. */
  operationCount: number;
  httpBet: HttpBet;
}

type Effect = 'DEBIT' | 'CREDIT' | 'NONE';

interface Operation {
  roundId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  externalTransactionId: string;
  amount: string;
  reference?: string;
  effect: Effect;
}

/** Tipos de rodada; cada wallet passa por todos, em ordem diferente. */
const ROUND_TYPES = ['WIN', 'LOSS', 'REFUND_FIRST', 'ROLLBACK_BET', 'ROLLBACK_WIN'] as const;
type RoundType = (typeof ROUND_TYPES)[number];

/**
 * Roteiro determinístico por wallet. Todas as operações terminam `PROCESSED`, então o saldo final
 * não depende da ordem entre wallets nem de quando a `REFUND` pendente é resolvida: é o saldo
 * inicial somado aos efeitos (calculado com `Money`). Inclui:
 * - `REFUND` enviada antes da `BET` que ela reverte (fica `PENDING_REFERENCE` até a `BET` chegar);
 * - reentrega do mesmo `messageId` (outro `MessageDeduplicationId`, para o SQS não descartar);
 * - a mesma operação em duas mensagens diferentes (replay idempotente, sem efeito);
 * - uma mensagem venenosa, num grupo próprio.
 */
export function buildScenario(wallets: ScenarioWallet[]): Scenario {
  const messages: ScriptedMessage[] = [];
  const expectedBalance = new Map<string, string>();
  const validMessageIds = new Set<string>();
  let operationCount = 0;

  wallets.forEach((wallet, w) => {
    const operations = Array.from({ length: ROUNDS_PER_WALLET }, (_, r) =>
      roundOperations(w, r, ROUND_TYPES[(w + r) % ROUND_TYPES.length] as RoundType),
    ).flat();
    operationCount += operations.length;

    const walletMessages: ScriptedMessage[] = operations.map((op, i) => {
      const messageId = `msg-w${w}-${i}`;
      validMessageIds.add(messageId);
      return {
        body: envelope(messageId, wagerData(wallet, w, op)),
        groupId: wallet.id,
        dedupId: messageId,
      };
    });

    // reentrega: mesmo corpo e mesmo `messageId`; a inbox reconhece e só confirma
    const redelivered = walletMessages[REDELIVERED_INDEX];
    if (!redelivered) throw new Error('scenario too short for a redelivery');
    walletMessages.splice(REDELIVERY_POSITION, 0, {
      ...redelivered,
      dedupId: `${redelivered.dedupId}:redelivery`,
    });

    // a mesma operação (primeira BET da wallet) numa mensagem nova: replay idempotente
    const firstBet = operations.find((op) => op.kind === 'BET');
    if (!firstBet) throw new Error('scenario without a BET');
    const duplicateId = `msg-w${w}-duplicate`;
    validMessageIds.add(duplicateId);
    walletMessages.splice(DUPLICATED_OPERATION_POSITION, 0, {
      body: envelope(duplicateId, wagerData(wallet, w, firstBet)),
      groupId: wallet.id,
      dedupId: duplicateId,
    });

    messages.push(...walletMessages);
    expectedBalance.set(wallet.id, applyEffects(INITIAL_BALANCE, operations));
  });

  messages.push({ body: POISON_BODY, groupId: POISON_GROUP_ID, dedupId: 'poison' });

  const httpBet = buildHttpBet(wallets);
  const current = expectedBalance.get(httpBet.walletId) ?? INITIAL_BALANCE;
  expectedBalance.set(
    httpBet.walletId,
    applyEffects(current, [{ amount: HTTP_BET_AMOUNT, effect: 'DEBIT' }]),
  );

  return {
    messages,
    expectedBalance,
    validMessageIds,
    operationCount: operationCount + 1,
    httpBet,
  };
}

function buildHttpBet(wallets: ScenarioWallet[]): HttpBet {
  const [wallet] = wallets;
  if (!wallet) throw new Error('scenario needs at least one wallet');
  const externalTransactionId = 'http-bet';
  return {
    walletId: wallet.id,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER_ID,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'http-round',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: HTTP_BET_AMOUNT, currency: CURRENCY },
    },
  };
}

/** Operações de uma rodada, na ordem em que o provedor as envia. */
function roundOperations(w: number, r: number, type: RoundType): Operation[] {
  const id = (suffix: string) => `w${w}-r${r}-${suffix}`;
  const stake = amountFor(w, r);
  const prize = amountFor(w, r + 7);
  const roundId = `round-w${w}-r${r}`;
  const op = (
    kind: Operation['kind'],
    suffix: string,
    amount: string,
    reference: Operation,
    effect: Effect,
  ): Operation => ({
    roundId,
    kind,
    externalTransactionId: id(suffix),
    amount,
    reference: reference.externalTransactionId,
    effect,
  });
  const bet: Operation = {
    roundId,
    kind: 'BET',
    externalTransactionId: id('bet'),
    amount: stake,
    effect: 'DEBIT',
  };
  switch (type) {
    case 'WIN':
      return [bet, op('WIN', 'win', prize, bet, 'CREDIT')];
    case 'LOSS':
      return [bet, op('LOSS', 'loss', stake, bet, 'NONE')];
    case 'REFUND_FIRST':
      return [op('REFUND', 'refund', stake, bet, 'CREDIT'), bet];
    case 'ROLLBACK_BET':
      return [bet, op('ROLLBACK', 'rollback', stake, bet, 'CREDIT')];
    case 'ROLLBACK_WIN': {
      const win = op('WIN', 'win', prize, bet, 'CREDIT');
      return [bet, win, op('ROLLBACK', 'rollback', prize, win, 'DEBIT')];
    }
  }
}

/** Valor determinístico entre 1.05 e 20.95, montado como texto (nunca ponto flutuante). */
function amountFor(w: number, r: number): string {
  const units = 1 + ((w * 7 + r * 3) % 20);
  const cents = 5 + ((w * 11 + r * 13) % 91);
  return `${units}.${String(cents).padStart(2, '0')}`;
}

function applyEffects(initial: string, operations: Pick<Operation, 'amount' | 'effect'>[]): string {
  let balance = Money.from({ amount: initial, currency: CURRENCY });
  for (const operation of operations) {
    const money = Money.from({ amount: operation.amount, currency: CURRENCY });
    if (operation.effect === 'DEBIT') balance = balance.subtract(money);
    if (operation.effect === 'CREDIT') balance = balance.add(money);
  }
  return balance.toJSON().amount;
}

function wagerData(wallet: ScenarioWallet, w: number, operation: Operation) {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId: operation.externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: operation.roundId,
    gameId: `game-${w}`,
    kind: operation.kind,
    money: { amount: operation.amount, currency: CURRENCY },
    ...(operation.reference ? { referenceExternalTransactionId: operation.reference } : {}),
    idempotencyKey: `${PROVIDER_ID}:${operation.externalTransactionId}`,
  };
}

function envelope(messageId: string, data: Record<string, unknown>) {
  return { messageId, type: MESSAGE_TYPE, occurredAt: OCCURRED_AT, data };
}
