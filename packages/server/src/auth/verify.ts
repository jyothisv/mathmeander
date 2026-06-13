// IdP JWT verification — THE one verification path (no environment-conditional bypass
// exists anywhere). jose against a remote JWKS + issuer/audience from env: the dev
// issuer and a hosted IdP (Clerk/WorkOS/…) are indistinguishable here, which is what
// makes the issuer swap config-only (arch doc §7; setup decision 3).
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface IdpVerifier {
  verify(idpToken: string): Promise<{ subject: string; email: string | null }>;
}

export function createIdpVerifier(opts: {
  issuer: string;
  jwksUrl: string;
  audience: string;
}): IdpVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return {
    async verify(idpToken: string) {
      const { payload }: { payload: JWTPayload } = await jwtVerify(idpToken, jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      if (!payload.sub) throw new Error('IdP token has no sub claim');
      const email = typeof payload.email === 'string' ? payload.email : null;
      return { subject: payload.sub, email };
    },
  };
}
