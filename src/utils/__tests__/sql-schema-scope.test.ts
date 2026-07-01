import { describe, it, expect } from "vitest";
import { assertSchemaAllowed, validateSqlSchemaScope } from "../sql-schema-scope.js";

describe("validateSqlSchemaScope", () => {
  it("allows unqualified SELECT within target schema scope", () => {
    expect(validateSqlSchemaScope("SELECT id, name FROM users", "public")).toEqual({ ok: true });
  });

  it("allows qualified references to the target schema", () => {
    expect(validateSqlSchemaScope("SELECT * FROM public.users", "public")).toEqual({ ok: true });
  });

  it("blocks cross-schema qualified references", () => {
    const result = validateSqlSchemaScope("SELECT * FROM other.users", "public");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cross_schema_reference");
    }
  });

  it("blocks cross-schema JOIN references", () => {
    const result = validateSqlSchemaScope(
      "SELECT u.id FROM users u JOIN other.orders o ON u.id = o.user_id",
      "public"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cross_schema_reference");
    }
  });

  it("blocks cross-schema references inside CTEs", () => {
    const result = validateSqlSchemaScope(
      "WITH x AS (SELECT 1) SELECT * FROM other.users",
      "public"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cross_schema_reference");
    }
  });

  it("blocks SET search_path statements", () => {
    const result = validateSqlSchemaScope("SET search_path TO public", "public");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_mutation");
    }
  });

  it("blocks RESET statements", () => {
    const result = validateSqlSchemaScope("RESET search_path", "public");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_mutation");
    }
  });

  it("blocks pg_catalog references", () => {
    const result = validateSqlSchemaScope(
      "SELECT relname FROM pg_catalog.pg_class",
      "public"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("catalog_access");
    }
  });

  it("blocks information_schema references", () => {
    const result = validateSqlSchemaScope(
      "SELECT table_name FROM information_schema.tables",
      "public"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("catalog_access");
    }
  });

  it("validates each statement in multi-statement SQL", () => {
    const result = validateSqlSchemaScope(
      "SELECT 1; SELECT * FROM other.users",
      "public"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cross_schema_reference");
    }
  });

  it("allows table.column references before FROM", () => {
    expect(
      validateSqlSchemaScope("SELECT users.id FROM users", "public")
    ).toEqual({ ok: true });
  });

  it("requires a non-empty target schema", () => {
    const result = validateSqlSchemaScope("SELECT 1", "");
    expect(result.ok).toBe(false);
  });
});

describe("assertSchemaAllowed", () => {
  it("allows any schema when allowlist is omitted", () => {
    expect(assertSchemaAllowed("clinical")).toEqual({ ok: true });
  });

  it("rejects schemas outside the allowlist", () => {
    const result = assertSchemaAllowed("staging", ["clinical"]);
    expect(result.ok).toBe(false);
  });

  it("matches allowlist case-insensitively", () => {
    expect(assertSchemaAllowed("Clinical", ["clinical"])).toEqual({ ok: true });
  });
});
