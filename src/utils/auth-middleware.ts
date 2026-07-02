import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

/**
 * Express middleware that requires a bearer token on the MCP endpoint (`/mcp`)
 * and the JSON API (`/api/*`). Health checks, static assets, and CORS preflight
 * are left open. Token comparison is constant-time.
 *
 * Returns a no-op passthrough when `token` is undefined/empty so that stdio and
 * trusted-localhost deployments are unaffected.
 */
export function createAuthMiddleware(
  token: string | undefined
): (req: Request, res: Response, next: NextFunction) => void {
  if (!token) {
    return (_req, _res, next) => next();
  }

  const expected = Buffer.from(token);

  const isValidToken = (provided: string): boolean => {
    const given = Buffer.from(provided);
    // Length mismatch is an early, safe reject; equal lengths use constant-time compare.
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return (req, res, next) => {
    const path = req.path ?? "";
    const isProtected = path === "/mcp" || path.startsWith("/api/");
    if (!isProtected || req.method === "OPTIONS") {
      return next();
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !isValidToken(match[1]!.trim())) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing or invalid bearer token",
      });
      return;
    }
    next();
  };
}
