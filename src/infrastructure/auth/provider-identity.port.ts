/** Identidade do provedor autenticado, extraída da requisição. */
export interface ProviderIdentity {
  providerId: string;
}

/**
 * Resolve qual provedor fez a requisição (ex.: a partir das claims do token do IdP).
 * Contrato que permite ao `AuthGuard` checar que o `providerId` do corpo é o mesmo do token.
 * Não há implementação registrada: a autenticação está desligada (ver ARCHITECTURE.md).
 */
export interface ProviderIdentityPort {
  resolve(request: unknown): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
