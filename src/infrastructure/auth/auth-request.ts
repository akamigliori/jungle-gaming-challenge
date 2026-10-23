import type { ProviderIdentity } from './provider-identity.port';

/** Requisição HTTP com o contexto de autenticação gravado pelo `AuthGuard`. */
export interface AuthenticatedRequest {
  auth?: ProviderIdentity;
}
