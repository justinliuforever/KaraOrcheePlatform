import type { RequestHandler } from "express";
import {
  jwtVerify,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from "jose";

export interface UserClaims {
  oid: string;
  email?: string;
  name?: string;
}

export interface AuthVerifier {
  verify(token: string): Promise<UserClaims>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserClaims;
    }
  }
}

interface JoseVerifierOptions {
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey;
}

export function createJoseVerifier(opts: JoseVerifierOptions): AuthVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, opts.jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      const oid = payload.oid;
      if (typeof oid !== "string" || oid.length === 0) {
        throw new Error("missing_oid");
      }
      const email =
        (typeof payload.email === "string" && payload.email) ||
        (typeof payload.preferred_username === "string" &&
          payload.preferred_username) ||
        undefined;
      const name =
        typeof payload.name === "string" ? payload.name : undefined;
      return { oid, email: email || undefined, name };
    },
  };
}

export function verifierFromConfig(auth: {
  tenantId: string;
  tenantName: string;
  audience: string;
}): AuthVerifier {
  const jwksUrl = `https://${auth.tenantName}.ciamlogin.com/${auth.tenantId}/discovery/v2.0/keys`;
  const issuer = `https://${auth.tenantId}.ciamlogin.com/${auth.tenantId}/v2.0`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return createJoseVerifier({ issuer, audience: auth.audience, jwks });
}

// Fail-closed: unconfigured -> 503; missing/invalid/expired token -> 401. No bypass.
export function requireAuth(verifier?: AuthVerifier): RequestHandler {
  return async (req, res, next) => {
    if (!verifier) {
      res.status(503).json({ error: "auth_not_configured" });
      return;
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      req.user = await verifier.verify(token);
      next();
    } catch {
      res.status(401).json({ error: "unauthorized" });
    }
  };
}
