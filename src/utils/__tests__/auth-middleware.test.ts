import { describe, it, expect, vi } from "vitest";
import { createAuthMiddleware } from "../auth-middleware.js";

type MockRes = {
  statusCode?: number;
  body?: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
};

function makeReqRes(opts: { path: string; method?: string; auth?: string }) {
  const req = {
    path: opts.path,
    method: opts.method ?? "POST",
    headers: opts.auth ? { authorization: opts.auth } : {},
  } as any;
  const res: MockRes = {
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("createAuthMiddleware", () => {
  it("is a no-op passthrough when no token is configured", () => {
    const mw = createAuthMiddleware(undefined);
    const { req, res, next } = makeReqRes({ path: "/mcp" });
    mw(req, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  describe("with a configured token", () => {
    const TOKEN = "correct-horse";
    const mw = createAuthMiddleware(TOKEN);

    it("allows /mcp with the correct bearer token", () => {
      const { req, res, next } = makeReqRes({ path: "/mcp", auth: `Bearer ${TOKEN}` });
      mw(req, res as any, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("allows /api/* with the correct token (case-insensitive scheme)", () => {
      const { req, res, next } = makeReqRes({ path: "/api/sources", auth: `bearer ${TOKEN}` });
      mw(req, res as any, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("rejects /mcp with no token", () => {
      const { req, res, next } = makeReqRes({ path: "/mcp" });
      mw(req, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("rejects /api/* with a wrong token", () => {
      const { req, res, next } = makeReqRes({ path: "/api/requests", auth: "Bearer nope" });
      mw(req, res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("rejects a token that is a prefix of the correct one (length check)", () => {
      const { req, res, next } = makeReqRes({ path: "/mcp", auth: "Bearer correct-hors" });
      mw(req, res as any, next);
      expect(res.statusCode).toBe(401);
    });

    it("does NOT guard health checks or static/other paths", () => {
      for (const path of ["/healthz", "/", "/assets/app.js", "/favicon.ico"]) {
        const { req, res, next } = makeReqRes({ path, method: "GET" });
        mw(req, res as any, next);
        expect(next, `${path} should pass through`).toHaveBeenCalledOnce();
      }
    });

    it("allows CORS preflight (OPTIONS) through unprotected", () => {
      const { req, res, next } = makeReqRes({ path: "/mcp", method: "OPTIONS" });
      mw(req, res as any, next);
      expect(next).toHaveBeenCalledOnce();
    });
  });
});
