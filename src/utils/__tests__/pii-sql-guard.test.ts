import { describe, it, expect } from "vitest";
import { validateSqlPiiAccessGuard } from "../pii-sql-guard.js";

describe("pii-sql-guard", () => {
  it("allows benign projections when access is denied (default guard)", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT id, created_at FROM orders WHERE id = 1",
      false
    );
    expect(r).toEqual({ ok: true });
  });

  it("blocks wildcard projections when access is denied", () => {
    const r = validateSqlPiiAccessGuard("SELECT * FROM patients", false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wildcard_projection");
    }
  });

  it("blocks suspected PII/clinical columns", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT id, email, blood_glucose FROM labs",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("suspected_pii_or_clinical_column");
    }
  });

  it("scans RETURNING lists in write statements", () => {
    const r = validateSqlPiiAccessGuard(
      `UPDATE users SET name = 'x' WHERE id = 1 RETURNING email`,
      false
    );
    expect(r.ok).toBe(false);
  });

  it("allows everything when allowAccess is true", () => {
    expect(validateSqlPiiAccessGuard("SELECT * FROM patients", true)).toEqual({ ok: true });
  });

  it("evaluates each statement in a batch", () => {
    const okBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT 1", false);
    expect(okBatch).toEqual({ ok: true });

    const badBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT email FROM u", false);
    expect(badBatch.ok).toBe(false);
  });
});
