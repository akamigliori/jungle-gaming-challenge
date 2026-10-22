import { z } from 'zod';
import type { MoneyProps } from '../../../domain/shared/money';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction';

/** Tipos que o provedor pode enviar; OPENING é interno e nunca entra pela API. */
const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export const MAX_TEXT_LENGTH = 255;

/** UUID aceito em qualquer caixa e normalizado para minúsculas (a mesma wallet, a mesma chave). */
const normalizedUuid = z.uuid().transform((value) => value.toLowerCase());
const providerText = z.string().min(1).max(MAX_TEXT_LENGTH);

/**
 * Só a forma do corpo é validada aqui; as regras do valor monetário (escala, sinal, moeda)
 * ficam no `Money` e geram `INVALID_MONEY`. O valor trafega sempre como string.
 */
export const submitWagerBodySchema = z.strictObject({
  providerId: providerText,
  externalTransactionId: providerText,
  playerId: normalizedUuid,
  walletId: normalizedUuid,
  roundId: providerText,
  gameId: providerText,
  kind: z.enum(SUBMITTABLE_KINDS),
  money: z.strictObject({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: providerText.optional(),
});

export type SubmitWagerBody = z.infer<typeof submitWagerBodySchema>;

/** Header obrigatório: 1 a 255 caracteres depois do trim. */
export const idempotencyKeySchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);

export const transactionIdParamsSchema = z.object({ transactionId: z.uuid() });

export const providerTransactionParamsSchema = z.object({
  providerId: providerText,
  externalTransactionId: providerText,
});

export interface SubmitWagerResponse {
  transactionId: string;
  status: string;
  /** Saldo da wallet após a transação; `null` enquanto a transação está pendente. */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

export interface RejectedWagerResponse extends SubmitWagerResponse {
  error: { code: string; message: string; retryable: false };
}

export function toSubmitResponse(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerResponse {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceAfter?.toJSON() ?? null,
    idempotentReplay,
  };
}

/** Rejeição por regra de negócio: corpo de erro uniforme mais os dados da transação gravada. */
export function toRejectedResponse(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): RejectedWagerResponse {
  const code = tx.failureCode ?? 'INTERNAL_ERROR';
  return {
    error: { code, message: `Transaction rejected: ${code}`, retryable: false },
    ...toSubmitResponse(tx, idempotentReplay),
  };
}
