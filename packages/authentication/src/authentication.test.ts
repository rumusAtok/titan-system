import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { hasAnyRole, principalFromClaims, TokenClaimsError } from './principal.js';
import { JwtVerifier } from './verifier.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ISSUER = 'http://idp.test/realms/titan';
const AUDIENCE = 'titan-api';

describe('principalFromClaims', () => {
  it('maps a user token', () => {
    const p = principalFromClaims(
      { sub: 'u1', preferred_username: 'alice', email: 'a@x.test', tenant_id: TENANT, department: 'PERMITS', realm_access: { roles: ['applicant'] } },
      'tok',
    );
    expect(p).toMatchObject({ userId: 'u1', username: 'alice', tenantId: TENANT, roles: ['applicant'], department: 'PERMITS', isService: false });
  });

  it('rejects a user token without a tenant claim', () => {
    expect(() => principalFromClaims({ sub: 'u1', realm_access: { roles: ['applicant'] } }, 't')).toThrow(TokenClaimsError);
  });

  it('rejects a malformed tenant claim', () => {
    expect(() => principalFromClaims({ sub: 'u1', tenant_id: "' OR 1=1 --", realm_access: { roles: [] } }, 't')).toThrow(TokenClaimsError);
  });

  it('gives service accounts the platform tenant, ignoring any tenant claim they present', () => {
    const p = principalFromClaims({ sub: 's1', tenant_id: TENANT, realm_access: { roles: ['service'] } }, 't');
    expect(p.isService).toBe(true);
    expect(p.tenantId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('treats a token without roles as having none', () => {
    const p = principalFromClaims({ sub: 'u1', tenant_id: TENANT }, 't');
    expect(p.roles).toEqual([]);
    expect(hasAnyRole(p, ['tenant_admin'])).toBe(false);
    expect(hasAnyRole(p, [])).toBe(true);
  });
});

describe('JwtVerifier', () => {
  let sign: (claims: Record<string, unknown>, options?: { issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey }) => Promise<string>;
  let verifier: JwtVerifier;
  let otherKey: CryptoKey;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    verifier = new JwtVerifier({ issuer: ISSUER, jwksUri: 'http://unused.test/jwks', audience: AUDIENCE }, createLocalJWKSet({ keys: [jwk] }));
    sign = (claims, options = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(options.key ?? privateKey);
  });

  const claims = { sub: 'u1', preferred_username: 'alice', tenant_id: TENANT, realm_access: { roles: ['applicant'] } };

  it('accepts a correctly signed token', async () => {
    const p = await verifier.verify(await sign(claims));
    expect(p.username).toBe('alice');
    expect(p.tenantId).toBe(TENANT);
  });

  it('rejects a token signed with a different key', async () => {
    await expect(verifier.verify(await sign(claims, { key: otherKey }))).rejects.toThrow();
  });

  it('rejects a token from another issuer', async () => {
    await expect(verifier.verify(await sign(claims, { issuer: 'http://evil.test/realms/titan' }))).rejects.toThrow();
  });

  it('rejects a token for another audience', async () => {
    await expect(verifier.verify(await sign(claims, { audience: 'some-other-api' }))).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    await expect(verifier.verify(await sign(claims, { expiresIn: '-1m' }))).rejects.toThrow();
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    await expect(verifier.verify(forged)).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const token = await sign(claims);
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, tenant_id: '22222222-2222-4222-8222-222222222222', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    await expect(verifier.verify(`${h}.${forgedPayload}.${s}`)).rejects.toThrow();
  });
});
