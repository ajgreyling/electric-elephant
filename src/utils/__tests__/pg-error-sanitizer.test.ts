import { describe, it, expect } from "vitest";
import { sanitizePgError } from "../pg-error-sanitizer.js";

describe("sanitizePgError", () => {
  it("keeps the base message and SQLSTATE code", () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: "23505",
    });
    const s = sanitizePgError(err) as Error & { code?: string };
    expect(s.message).toBe('duplicate key value violates unique constraint "users_email_key"');
    expect(s.code).toBe("23505");
  });

  it("strips value-bearing fields (detail/hint/where/internalQuery/query)", () => {
    const err = Object.assign(new Error("unique violation"), {
      code: "23505",
      detail: "Key (email)=(bob@example.com) already exists.",
      hint: "some hint",
      where: "PL/pgSQL function ...",
      internalQuery: "SELECT email FROM users",
      query: "INSERT INTO users(email) VALUES ('bob@example.com')",
    });
    const s = sanitizePgError(err) as Record<string, unknown>;
    expect(s.detail).toBeUndefined();
    expect(s.hint).toBeUndefined();
    expect(s.where).toBeUndefined();
    expect(s.internalQuery).toBeUndefined();
    expect(s.query).toBeUndefined();
    // And the personal value must not appear anywhere on the sanitized error.
    expect(JSON.stringify(s) + (s as Error).message).not.toContain("bob@example.com");
  });

  it("handles non-Error throwables", () => {
    expect(sanitizePgError("boom").message).toBe("boom");
    expect(sanitizePgError(undefined).message).toBe("Unknown database error");
    expect(sanitizePgError({ detail: "Key (x)=(y)" }).message).toBe("Unknown database error");
  });
});
