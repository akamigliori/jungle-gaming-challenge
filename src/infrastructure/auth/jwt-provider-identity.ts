import { JwtVerifier } from './jwt-verifier';
import type { ProviderIdentity, ProviderIdentityPort } from './provider-identity.port';

/** Requisição com os headers de autenticação (formato do Express). */
interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Extrai o bearer token da requisição e o valida. Sem header, sem o prefixo `Bearer ` ou com
 * token inválido, devolve `null` (a decisão de negar fica com o guard).
 */
export class JwtProviderIdentity implements ProviderIdentityPort {
  constructor(private readonly verifier: JwtVerifier) {}

  async resolve(request: unknown): Promise<ProviderIdentity | null> {
    const token = bearerToken(request);
    if (!token) return null;
    return this.verifier.verify(token);
  }
}

function bearerToken(request: unknown): string | null {
  const headers = (request as RequestWithHeaders | null)?.headers;
  if (!headers) return null;
  const authorization = headers.authorization;
  if (typeof authorization !== 'string') return null;
  if (!authorization.startsWith(BEARER_PREFIX)) return null;
  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
