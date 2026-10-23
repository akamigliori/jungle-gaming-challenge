import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Parâmetros de verificação do token emitido pelo IdP. */
export interface JwtVerifierConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/** Claims validadas de um token aceito. */
export interface VerifiedJwt {
  providerId: string;
  scopes: string[];
}

/** Tolerância de relógio entre a instância e o IdP, em segundos. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Valida a assinatura e as claims de um bearer token contra o JWKS do IdP.
 * A assinatura é conferida localmente (sem chamar o IdP por requisição); o `kid` desconhecido
 * dispara uma nova leitura do JWKS por trás do `createRemoteJWKSet`.
 */
export class JwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: JwtVerifierConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  /** Devolve a identidade extraída do token, ou `null` quando o token não é válido. */
  async verify(token: string): Promise<VerifiedJwt | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      if (typeof payload.azp !== 'string' || payload.azp.length === 0) return null;
      const scopes =
        typeof payload.scope === 'string'
          ? payload.scope.split(' ').filter((s) => s.length > 0)
          : [];
      return { providerId: payload.azp, scopes };
    } catch {
      return null;
    }
  }
}
