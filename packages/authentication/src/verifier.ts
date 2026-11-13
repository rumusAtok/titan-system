import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { principalFromClaims, type Principal } from './principal.js';

export interface JwtVerifierOptions {
  /** Expected `iss` claim (the public Keycloak realm URL). */
  issuer: string;
  /** Where to fetch signing keys. May differ from the issuer host inside a cluster. */
  jwksUri: string;
  /** Expected `aud` claim. */
  audience: string;
}

/** Verifies signature, issuer, audience and expiry of access tokens. */
export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly options: JwtVerifierOptions,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys =
      keys ??
      createRemoteJWKSet(new URL(options.jwksUri), {
        cooldownDuration: 10_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 5_000,
      });
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ['RS256', 'ES256', 'PS256'],
      clockTolerance: 5,
    });
    return principalFromClaims(payload as Record<string, unknown>, token);
  }
}
