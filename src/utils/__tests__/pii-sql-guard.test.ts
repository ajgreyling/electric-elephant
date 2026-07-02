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

  describe("bypass resistance (whole-row/record projections, even with override on)", () => {
    // These project an entire row (all columns, incl. hard-excluded) WITHOUT
    // naming any PII column — they must be blocked as an unprovable-safe risk.
    const bypasses = [
      "SELECT to_json(users) FROM users",
      "SELECT row_to_json(u) FROM users u",
      "SELECT to_jsonb(u) FROM users u",
      "SELECT json_agg(users) FROM users",
      "SELECT jsonb_agg(u) FROM users u",
      "SELECT array_agg(u) FROM users u",
      "SELECT hstore(users) FROM users",
      "SELECT row(u.*) FROM users u",
      "SELECT u FROM users u",
      "SELECT users FROM users",
      "SELECT public.users FROM public.users",
      // Records passed through builders / nested serializers (found via re-attack).
      "SELECT jsonb_build_object('u', u) FROM users u",
      "SELECT json_build_object('u', u) FROM users u",
      "SELECT jsonb_agg(row_to_json(u)) FROM users u",
      "SELECT array_to_json(array_agg(u)) FROM users u",
      "SELECT json_object_agg(id, u) FROM users u",
      "SELECT to_json(row(u.*)) FROM users u",
      "SELECT unnest(array_agg(u)) FROM users u",
      "SELECT jsonb_each(to_jsonb(u)) FROM users u",
      // Record aliased through a CTE, then projected downstream.
      "WITH t AS (SELECT u AS rec FROM users u) SELECT rec FROM t",
    ];
    for (const sql of bypasses) {
      it(`blocks: ${sql}`, () => {
        const r = validateSqlPiiAccessGuard(sql, true);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("wildcard_clinical_risk");
        }
      });
    }

    it("blocks whole-table dump statements (COPY <table> TO, TABLE <name>)", () => {
      for (const sql of ["COPY users TO STDOUT", "COPY public.users TO STDOUT", "TABLE users"]) {
        const r = validateSqlPiiAccessGuard(sql, true);
        expect(r.ok, `${sql} should be blocked`).toBe(false);
        if (!r.ok) { expect(r.reason).toBe("wildcard_clinical_risk"); }
      }
    });

    it("does not over-block COPY of an explicit projection or 'copy'/'table' in a string", () => {
      expect(validateSqlPiiAccessGuard("COPY (SELECT id, status FROM users) TO STDOUT", true)).toEqual({ ok: true });
      expect(
        validateSqlPiiAccessGuard("SELECT id FROM mytable WHERE label = 'copy to me'", true)
      ).toEqual({ ok: true });
    });

    it("blocks a double-quoted PII identifier (quotes must not hide the name)", () => {
      const r = validateSqlPiiAccessGuard('SELECT "email" FROM users', true);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("hard_pii_blocked");
      }
    });

    it("does not over-block: scalar projections and qualified columns stay allowed", () => {
      // Record detection must not fire on qualified alias.column or scalar exprs.
      const allowed = [
        "SELECT count(*) FROM users u",
        'SELECT "id", "status" FROM users',
        "SELECT u.status FROM users u",
        "SELECT jsonb_agg(u.status) FROM users u",
        "SELECT json_build_object('s', u.status) FROM users u",
        "SELECT upper(u.status) FROM users u",
        "SELECT o.total, o.created_at FROM orders o JOIN users u ON u.id = o.user_id",
      ];
      for (const sql of allowed) {
        expect(validateSqlPiiAccessGuard(sql, true), `${sql} should be allowed`).toEqual({ ok: true });
      }
    });

    it("does not over-block correlated scalar subqueries (nested FROM alias is not a record projection)", () => {
      // The bare alias in a nested `FROM orders o` is an alias DEFINITION, not a
      // projected record — these must stay allowed.
      const allowed = [
        "SELECT id, (SELECT count(*) FROM orders o WHERE o.uid = p.id) AS n FROM patients p",
        "SELECT p.id, (SELECT max(o.total) FROM orders o WHERE o.uid = p.id) FROM patients p",
      ];
      for (const sql of allowed) {
        expect(validateSqlPiiAccessGuard(sql, true), `${sql} should be allowed`).toEqual({ ok: true });
      }
    });
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
