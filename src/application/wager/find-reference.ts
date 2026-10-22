import type { ReferenceView } from '../../domain/wager/wager-decision';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';

/**
 * Busca a transação referenciada por `tx` (mesmo provedor, id externo) e se ela já foi revertida.
 * `null` quando a referência ainda não existe; também `null` quando `tx` não traz referência
 * (as regras a ignoram nesse caso). Roda com a wallet travada, dentro da transação do chamador.
 */
export async function findReference(
  transactions: WagerTransactionRepository,
  tx: WagerTransaction,
): Promise<ReferenceView | null> {
  if (tx.referenceExternalTransactionId === undefined) return null;
  const transaction = await transactions.findByExternalId(
    tx.providerId,
    tx.referenceExternalTransactionId,
  );
  if (!transaction) return null;
  return { transaction, alreadyReversed: await transactions.isReversed(transaction.id) };
}
