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

  it("blocks eLabs HL7/clinical payload fields", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT barcode, orderID, hl7messagecontrolid, resultForAction FROM results_integration",
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

  describe("guard disabled (allowAccess true)", () => {
    it("allows wildcard SELECT *", () => {
      expect(validateSqlPiiAccessGuard("SELECT * FROM patients", true)).toEqual({ ok: true });
    });

    it("allows table.* projections", () => {
      expect(validateSqlPiiAccessGuard("SELECT u.* FROM users u", true)).toEqual({ ok: true });
    });

    it("allows suspected PII and clinical column names", () => {
      expect(
        validateSqlPiiAccessGuard(
          "SELECT id, email, blood_glucose, tax_id FROM patient_record",
          true
        )
      ).toEqual({ ok: true });
    });

    it("allows eLabs HL7-style payload columns", () => {
      expect(
        validateSqlPiiAccessGuard(
          "SELECT barcode, orderID, hl7messagecontrolid, resultForAction FROM results_integration",
          true
        )
      ).toEqual({ ok: true });
    });

    it("allows RETURNING lists that would be blocked when guard is on", () => {
      expect(
        validateSqlPiiAccessGuard(
          `UPDATE users SET name = 'x' WHERE id = 1 RETURNING email, *`,
          true
        )
      ).toEqual({ ok: true });
    });

    it("allows multi-statement batches that include PII projections", () => {
      expect(
        validateSqlPiiAccessGuard("SELECT id FROM t; SELECT email FROM u", true)
      ).toEqual({ ok: true });
    });
  });

  it("blocks FHIR/LOINC/SNOMED columns by default (all standards enabled)", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT subject_reference, loinc_code, snomed_ct_code FROM observations",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("suspected_pii_or_clinical_column");
    }
  });

  it("respects explicitly configured clinical standards", () => {
    const allowWhenFhirDisabled = validateSqlPiiAccessGuard(
      "SELECT subject_reference FROM observations",
      false,
      ["hl7v2"]
    );
    expect(allowWhenFhirDisabled).toEqual({ ok: true });

    const blockWhenFhirEnabled = validateSqlPiiAccessGuard(
      "SELECT subject_reference FROM observations",
      false,
      ["fhir"]
    );
    expect(blockWhenFhirEnabled.ok).toBe(false);
  });

  it("evaluates each statement in a batch", () => {
    const okBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT 1", false);
    expect(okBatch).toEqual({ ok: true });

    const badBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT email FROM u", false);
    expect(badBatch.ok).toBe(false);
  });
});
