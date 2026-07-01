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
      expect(r.reason).toBe("wildcard_clinical_risk");
    }
  });

  it("blocks generic PII columns (email, tax_id) as hard-excluded even when access denied", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT id, email, tax_id FROM customers",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("hard_pii_blocked");
    }
  });

  it("blocks mobile/phone (the overridable field) when access is denied", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT id, mobile_number FROM users",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("suspected_pii_or_clinical_column");
    }
  });

  it("blocks clinical/health columns as hard-excluded", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT id, blood_glucose FROM labs",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("clinical_health_data_blocked");
    }
  });

  it("blocks eLabs HL7/clinical payload fields as hard-excluded", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT barcode, orderID, hl7messagecontrolid, resultForAction FROM results_integration",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("clinical_health_data_blocked");
    }
  });

  it("scans RETURNING lists in write statements", () => {
    const r = validateSqlPiiAccessGuard(
      `UPDATE users SET name = 'x' WHERE id = 1 RETURNING email`,
      false
    );
    expect(r.ok).toBe(false);
  });

  describe("hard exclusion cannot be overridden by allow_access_to_pii_data", () => {
    it("still blocks wildcard SELECT * even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard("SELECT * FROM patients", true);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("wildcard_clinical_risk");
      }
    });

    it("still blocks table.* projections even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard("SELECT u.* FROM users u", true);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("wildcard_clinical_risk");
      }
    });

    it("still blocks clinical/health columns even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT id, blood_glucose FROM patient_record",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("clinical_health_data_blocked");
      }
    });

    it("still blocks eLabs HL7-style payload columns even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT barcode, orderID, hl7messagecontrolid, resultForAction FROM results_integration",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("clinical_health_data_blocked");
      }
    });

    it("still blocks clinical fields in RETURNING even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard(
        `UPDATE labs SET reviewed = true WHERE id = 1 RETURNING hiv_status`,
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("clinical_health_data_blocked");
      }
    });

    it("blocks clinical data hidden inside a subquery even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT id, (SELECT hiv_status FROM labs l WHERE l.pid = p.id) AS s FROM patients p",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("clinical_health_data_blocked");
      }
    });

    it("blocks clinical data in any statement of a batch even when access is allowed", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT id FROM t; SELECT loinc_code FROM observations",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("clinical_health_data_blocked");
      }
    });
  });

  describe("only mobile/phone is overridable by allow_access_to_pii_data", () => {
    it("allows mobile/phone number when access is allowed", () => {
      expect(
        validateSqlPiiAccessGuard(
          "SELECT id, mobile_number, phone FROM users",
          true
        )
      ).toEqual({ ok: true });
    });

    it("allows mobile in RETURNING when access is allowed", () => {
      expect(
        validateSqlPiiAccessGuard(
          `UPDATE users SET verified = true WHERE id = 1 RETURNING mobile_number`,
          true
        )
      ).toEqual({ ok: true });
    });

    it("still blocks email/name even when access is allowed (hard PII)", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT id, email, full_name FROM customers",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("hard_pii_blocked");
      }
    });

    it("still blocks national identifiers even when access is allowed (hard PII)", () => {
      const r = validateSqlPiiAccessGuard(
        "SELECT id, national_id FROM customers",
        true
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("hard_pii_blocked");
      }
    });
  });

  it("blocks FHIR/LOINC/SNOMED columns as hard-excluded (all standards)", () => {
    const r = validateSqlPiiAccessGuard(
      "SELECT subject_reference, loinc_code, snomed_ct_code FROM observations",
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("clinical_health_data_blocked");
    }
  });

  it("clinical block ignores a narrowed clinical_standards list", () => {
    // Even if only hl7v2 is configured, FHIR clinical fields remain hard-excluded.
    const r = validateSqlPiiAccessGuard(
      "SELECT subject_reference FROM observations",
      false,
      ["hl7v2"]
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("clinical_health_data_blocked");
    }
  });

  it("evaluates each statement in a batch", () => {
    const okBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT 1", false);
    expect(okBatch).toEqual({ ok: true });

    const badBatch = validateSqlPiiAccessGuard("SELECT id FROM t; SELECT email FROM u", false);
    expect(badBatch.ok).toBe(false);
  });
});
