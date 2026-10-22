import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../application/wager/payload-hash';
import {
  idempotencyKeySchema,
  MAX_TEXT_LENGTH,
  submitWagerBodySchema,
} from '../http/wagering/wager.dto';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Envelope estrito: `data` é o corpo HTTP mais a chave de idempotência. */
export const wagerMessageSchema = z.strictObject({
  messageId: z.string().min(1).max(MAX_TEXT_LENGTH),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: submitWagerBodySchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export type ParsedWagerMessage = { ok: true; message: WagerMessage } | { ok: false };

/** JSON inválido e mensagem fora do schema têm o mesmo resultado: não adianta tentar de novo. */
export function parseWagerMessage(body: string): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  const parsed = wagerMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false };
}

/** SHA-256 do JSON canônico de `data` (inclui a chave de idempotência); identifica o conteúdo da entrega. */
export function messageHash(data: WagerMessage['data']): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex');
}
