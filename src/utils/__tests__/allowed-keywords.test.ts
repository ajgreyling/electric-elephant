import { describe, it, expect } from "vitest";
import { isReadOnlySQL } from "../allowed-keywords.js";

describe("isReadOnlySQL (PostgreSQL)", () => {
  describe("basic read-only detection", () => {
    it("should identify SELECT as read-only", () => {
      expect(isReadOnlySQL("SELECT * FROM users")).toBe(true);
    });

    it("should identify WITH as read-only", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
    });

    it("should identify EXPLAIN as read-only", () => {
      expect(isReadOnlySQL("EXPLAIN SELECT * FROM users")).toBe(true);
    });

    it("should identify INSERT as not read-only", () => {
      expect(isReadOnlySQL("INSERT INTO users VALUES (1)")).toBe(false);
    });

    it("should identify UPDATE as not read-only", () => {
      expect(isReadOnlySQL("UPDATE users SET name = 'test'")).toBe(false);
    });

    it("should identify DELETE as not read-only", () => {
      expect(isReadOnlySQL("DELETE FROM users")).toBe(false);
    });
  });

  describe("comment handling", () => {
    it("should detect read-only after stripping single-line comment", () => {
      const sql = "-- this is a comment\nSELECT * FROM users";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should detect read-only after stripping multi-line comment", () => {
      const sql = "/* INSERT */ SELECT * FROM users";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should detect non-read-only after stripping comment with SELECT", () => {
      const sql = "/* SELECT */ INSERT INTO users VALUES (1)";
      expect(isReadOnlySQL(sql)).toBe(false);
    });

    it("should handle commented-out destructive statement before real read-only", () => {
      const sql = "-- DELETE FROM users\nSELECT * FROM users";
      expect(isReadOnlySQL(sql)).toBe(true);
    });
  });

  describe("PostgreSQL keywords", () => {
    it("should recognize SHOW as read-only", () => {
      expect(isReadOnlySQL("SHOW search_path")).toBe(true);
    });

    it("should reject standalone ANALYZE (updates statistics)", () => {
      expect(isReadOnlySQL("ANALYZE users")).toBe(false);
    });

    it("should allow REPLACE() as a function in SELECT", () => {
      expect(isReadOnlySQL("SELECT REPLACE(name, 'a', 'b') FROM users")).toBe(true);
    });

    it("should allow REPLACE() inside a WITH CTE", () => {
      const sql =
        "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS cleaned FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql)).toBe(true);
    });
  });

  describe("CTE with mutating operations", () => {
    it("should reject UPDATE inside a CTE", () => {
      const sql =
        "WITH updated AS (UPDATE contracts SET site_location_postcode = 'SW11' WHERE id = 1 RETURNING id) SELECT * FROM updated";
      expect(isReadOnlySQL(sql)).toBe(false);
    });

    it("should reject DELETE inside a CTE", () => {
      const sql =
        "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM deleted";
      expect(isReadOnlySQL(sql)).toBe(false);
    });

    it("should reject INSERT inside a CTE", () => {
      const sql =
        "WITH inserted AS (INSERT INTO users (name) VALUES ('test') RETURNING *) SELECT * FROM inserted";
      expect(isReadOnlySQL(sql)).toBe(false);
    });

    it("should allow a pure SELECT CTE", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should reject DROP inside a CTE-like construct", () => {
      const sql = "WITH x AS (SELECT 1) DROP TABLE users";
      expect(isReadOnlySQL(sql)).toBe(false);
    });

    it("should not be fooled by mutating keywords in string literals", () => {
      const sql = "SELECT * FROM users WHERE name = 'UPDATE me'";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should not be fooled by mutating keywords in comments", () => {
      const sql = "/* UPDATE users SET x = 1 */ SELECT * FROM users";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should allow a CTE named 'replace'", () => {
      const sql = "WITH replace AS (SELECT 1) SELECT * FROM replace";
      expect(isReadOnlySQL(sql)).toBe(true);
    });

    it("should reject WITH ... SELECT INTO", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * INTO new_table FROM cte";
      expect(isReadOnlySQL(sql)).toBe(false);
    });
  });

  describe("EXPLAIN", () => {
    it("should allow EXPLAIN with mutating statement (plan only)", () => {
      expect(isReadOnlySQL("EXPLAIN DELETE FROM users")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE with DML", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE DELETE FROM users")).toBe(false);
    });

    it("should reject EXPLAIN (ANALYZE) with DML", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE) DELETE FROM users")).toBe(false);
    });

    it("should allow EXPLAIN ANALYZE with SELECT", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE SELECT * FROM users")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE with SELECT INTO", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE SELECT * INTO new_table FROM users")).toBe(false);
    });

    it("should allow EXPLAIN ANALYZE VERBOSE with SELECT", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE VERBOSE SELECT * FROM users")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE VERBOSE with DML", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE VERBOSE DELETE FROM users")).toBe(false);
    });

    it("should allow EXPLAIN (ANALYZE false) with DML (not executed)", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE false) DELETE FROM users")).toBe(true);
    });

    it("should allow EXPLAIN (ANALYZE off) with DML (not executed)", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE off) DELETE FROM users")).toBe(true);
    });
  });

  describe("SELECT INTO", () => {
    it("should reject SELECT INTO (table creation)", () => {
      expect(isReadOnlySQL("SELECT * INTO new_table FROM users")).toBe(false);
    });

    it("should reject SELECT INTO with WHERE clause", () => {
      expect(
        isReadOnlySQL(
          "SELECT id, name INTO backup_table FROM users WHERE active = true"
        )
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should treat empty SQL after comment stripping as not read-only", () => {
      expect(isReadOnlySQL("-- just a comment")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isReadOnlySQL("select * from users")).toBe(true);
      expect(isReadOnlySQL("SELECT * FROM users")).toBe(true);
    });
  });

  describe("Conditional /*! ... */ comments are stripped (read-only safety)", () => {
    it("should reject when /*! ... */ strips to empty", () => {
      expect(isReadOnlySQL("/*!50000 DELETE FROM users WHERE 1=1 */")).toBe(false);
    });

    it("should treat /*! ... SELECT ... */ as a comment (not executable text)", () => {
      expect(isReadOnlySQL("/*!50000 SELECT 1 */")).toBe(false);
    });
  });
});
