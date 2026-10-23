import { afterAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { JwtVerifier } from '../../../src/infrastructure/auth/jwt-verifier';

const ISSUER = 'http://localhost:8080/realms/wagering';
const AUDIENCE = 'wagering-app';
const KID = 'test-kid';

/** Par de chaves e JWKS servido num servidor local para o `createRemoteJWKSet`. */
async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...publicJwk, alg: 'RS256', kid: KID }] };
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } }),
  });
  return {
    privateKey,
    jwksUri: `http://localhost:${server.port}/jwks`,
    close: () => server.stop(true),
  };
}

function sign(payload: Record<string, unknown>, privateKey: CryptoKey, kid = KID): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

let close: () => void;

afterAll(() => {
  close?.();
});

describe('JwtVerifier', () => {
  test('aceita token válido e extrai providerId e scopes', async () => {
    const { privateKey, jwksUri, close: stop } = await setup();
    close = stop;
    const verifier = new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const token = await sign({ azp: 'provider-a', scope: 'wagers:submit wagers:read' }, privateKey);

    expect(await verifier.verify(token)).toEqual({
      providerId: 'provider-a',
      scopes: ['wagers:submit', 'wagers:read'],
    });
  });

  test('rejeita token expirado (além da tolerância)', async () => {
    const { privateKey, jwksUri, close: stop } = await setup();
    close = stop;
    const verifier = new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const token = await new SignJWT({ azp: 'provider-a', scope: 'wagers:submit' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    expect(await verifier.verify(token)).toBeNull();
  });

  test('rejeita token com aud errado', async () => {
    const { privateKey, jwksUri, close: stop } = await setup();
    close = stop;
    const verifier = new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const token = await new SignJWT({ azp: 'provider-a', scope: 'wagers:submit' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience('outro-audience')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    expect(await verifier.verify(token)).toBeNull();
  });

  test('rejeita token com assinatura de outra chave', async () => {
    const { jwksUri, close: stop } = await setup();
    close = stop;
    const verifier = new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const { privateKey: other } = await generateKeyPair('RS256');
    const token = await sign({ azp: 'provider-a', scope: 'wagers:submit' }, other);

    expect(await verifier.verify(token)).toBeNull();
  });

  test('rejeita token sem a claim do provedor (azp)', async () => {
    const { privateKey, jwksUri, close: stop } = await setup();
    close = stop;
    const verifier = new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const token = await sign({ scope: 'wagers:submit' }, privateKey);

    expect(await verifier.verify(token)).toBeNull();
  });
});
