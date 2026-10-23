/** Identidade do provedor autenticado, extraída da requisição. */
export interface ProviderIdentity {
  providerId: string;
  /** Escopos concedidos ao cliente (ex.: `wagers:submit`, `wallets:manage`). */
  scopes: string[];
}

/**
 * Resolve qual provedor fez a requisição (ex.: a partir das claims do token do IdP).
 * Contrato que permite ao `AuthGuard` checar que o `providerId` do corpo é o mesmo do token.
 * Sem token ou token inválido, devolve `null`; o guard decide o que fazer com isso.
 */
export interface ProviderIdentityPort {
  resolve(request: unknown): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
