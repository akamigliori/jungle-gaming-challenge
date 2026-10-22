import { z } from 'zod';
import type { MoneyProps } from '../../../domain/shared/money';
import type { Wallet } from '../../../domain/wallet/wallet';

/** Tamanho de página do ledger: padrão e limites aceitos. */
export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

/**
 * Só a forma do corpo é validada aqui; as regras do valor monetário (escala, sinal,
 * moeda) ficam no `Money` e geram `INVALID_MONEY`.
 */
export const createWalletBodySchema = z.object({
  playerId: z.uuid(),
  initialBalance: z.strictObject({ amount: z.string(), currency: z.string() }),
});

export const walletIdParamsSchema = z.object({ walletId: z.uuid() });

export const ledgerQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_MAX_LIMIT).default(LEDGER_DEFAULT_LIMIT),
});

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
