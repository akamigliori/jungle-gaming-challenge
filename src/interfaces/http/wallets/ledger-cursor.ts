import { InvalidPayloadError } from '../../../domain/shared/domain-error';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Versão de wallet: inteiro positivo, sem zeros à esquerda. */
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Cursor opaco da paginação do ledger: base64url da última `wallet_version` devolvida. */
export function encodeCursor(version: number): string {
  return Buffer.from(String(version)).toString('base64url');
}

/** Lê o cursor; qualquer valor que não tenha sido produzido por `encodeCursor` é rejeitado. */
export function decodeCursor(cursor: string): number {
  if (!BASE64URL.test(cursor)) throw invalidCursor();
  const decoded = Buffer.from(cursor, 'base64url').toString();
  if (!POSITIVE_INTEGER.test(decoded)) throw invalidCursor();
  const version = Number(decoded);
  // o cursor precisa ser exatamente a codificação canônica da versão
  if (!Number.isSafeInteger(version) || encodeCursor(version) !== cursor) throw invalidCursor();
  return version;
}

function invalidCursor(): InvalidPayloadError {
  return new InvalidPayloadError('cursor is invalid');
}
