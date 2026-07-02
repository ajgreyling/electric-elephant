import { describe, it, expect } from "vitest";
import {
  stripCommentsAndStrings,
  stripCommentsStringsAndIdentifiers,
  redactSqlLiterals,
  splitSQLStatements,
} from "../sql-parser.js";

describe("redactSqlLiterals", () => {
  it("masks string literals but preserves query shape", () => {
    expect(redactSqlLiterals("SELECT id FROM users WHERE email = 'bob@x.com'")).toBe(
      "SELECT id FROM users WHERE email = '?'"
    );
  });

  it("masks numeric literals as whole tokens", () => {
    expect(redactSqlLiterals("SELECT * FROM t WHERE age = 42 AND score >= 99.95 LIMIT 10")).toBe(
      "SELECT * FROM t WHERE age = ? AND score >= ? LIMIT ?"
    );
  });

  it("preserves identifiers that contain digits", () => {
    expect(redactSqlLiterals("SELECT md5(x), int4col, x1 FROM t")).toBe(
      "SELECT md5(x), int4col, x1 FROM t"
    );
  });

  it("preserves double-quoted identifiers verbatim (no numeric masking)", () => {
    expect(redactSqlLiterals('SELECT "email1" FROM users WHERE id IN (1,2,3)')).toBe(
      'SELECT "email1" FROM users WHERE id IN (?,?,?)'
    );
  });

  it("drops comments (which can contain personal data)", () => {
    expect(redactSqlLiterals("SELECT id -- note: bob@x.com\n FROM users")).toBe(
      "SELECT id FROM users"
    );
  });

  it("redacts values in INSERT/UPDATE", () => {
    expect(redactSqlLiterals("UPDATE users SET password = 'secret' WHERE id = 7")).toBe(
      "UPDATE users SET password = '?' WHERE id = ?"
    );
  });
});

describe("stripCommentsAndStrings (PostgreSQL)", () => {
  describe("single-line comments (--)", () => {
    it("should strip single-line comment at end of line", () => {
      const sql = "SELECT * FROM users -- comment";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM users  ");
    });

    it("should strip single-line comment and preserve next line", () => {
      const sql = "SELECT * FROM users -- comment\nWHERE active = true";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM users  \nWHERE active = true");
    });
  });

  describe("multi-line comments (/* */)", () => {
    it("should strip inline multi-line comment", () => {
      const sql = "SELECT * /* comment */ FROM users";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *   FROM users");
    });

    it("should handle nested block comments", () => {
      const sql = "SELECT /* outer /* inner */ still comment */ 1";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   1");
    });

    it("should strip /*! ... */ conditional block comments as non-executable text", () => {
      const sql = "SELECT 1; /*!50000 DELETE FROM users */";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT 1;  ");
    });

    it("should handle deeply nested block comments", () => {
      const sql = "SELECT /* a /* b /* c */ b */ a */ 1";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   1");
    });
  });

  describe("strings and double-quoted identifiers", () => {
    it("should strip single-quoted strings", () => {
      expect(stripCommentsAndStrings("SELECT 'hello' AS msg")).toBe("SELECT   AS msg");
    });

    it("should PRESERVE double-quoted identifiers (they are column/table names, not string literals)", () => {
      // Stripping these would erase column names from downstream guards (PII,
      // schema-scope), letting `SELECT "email"` bypass name-based detection.
      expect(stripCommentsAndStrings('SELECT * FROM "my table"')).toBe('SELECT * FROM "my table"');
      expect(stripCommentsAndStrings('SELECT "email" FROM users')).toBe('SELECT "email" FROM users');
    });

    it("still strips single-quoted string literals even next to quoted identifiers", () => {
      expect(stripCommentsAndStrings(`SELECT "email" FROM users WHERE name = 'bob'`)).toBe(
        'SELECT "email" FROM users WHERE name =  '
      );
    });
  });

  describe("dollar-quoted blocks", () => {
    it("should strip $$ block", () => {
      const sql = "DO $$ BEGIN RAISE NOTICE 'test'; END; $$";
      expect(stripCommentsAndStrings(sql)).toBe("DO  ");
    });

    it("should NOT consume $1 as dollar-quote", () => {
      const sql = "SELECT $1, $2 FROM users WHERE id = $3";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT $1, $2 FROM users WHERE id = $3");
    });

    it("should strip dollar-quote with semicolons inside", () => {
      const sql =
        "CREATE FUNCTION foo() RETURNS void AS $$ DELETE FROM bar; INSERT INTO baz VALUES (1); $$ LANGUAGE plpgsql";
      expect(stripCommentsAndStrings(sql)).toBe(
        "CREATE FUNCTION foo() RETURNS void AS   LANGUAGE plpgsql"
      );
    });
  });

  describe("backticks and brackets (not special in PostgreSQL)", () => {
    it("should leave backticks as plain text", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM `my table`");
    });

    it("should leave brackets as plain text", () => {
      const sql = "SELECT * FROM [my table]";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM [my table]");
    });
  });
});

describe("splitSQLStatements (PostgreSQL)", () => {
  it("should split simple statements", () => {
    expect(splitSQLStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("should not split on semicolon inside string", () => {
    expect(splitSQLStatements("SELECT 'a;b'")).toEqual(["SELECT 'a;b'"]);
  });

  it("should not split inside dollar-quoted block", () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'test'; END; $$";
    expect(splitSQLStatements(sql)).toEqual([sql]);
  });

  it("should split after dollar-quoted block", () => {
    const sql = "DO $$ BEGIN NULL; END; $$; SELECT 1";
    expect(splitSQLStatements(sql)).toEqual(["DO $$ BEGIN NULL; END; $$", "SELECT 1"]);
  });

  it("should split on semicolon inside backticks (not quoted in PG)", () => {
    const sql = "SELECT * FROM `table; name`";
    expect(splitSQLStatements(sql)).toEqual(["SELECT * FROM `table", "name`"]);
  });

  it("should handle CREATE FUNCTION with dollar-quoting", () => {
    const sql = `
        CREATE OR REPLACE FUNCTION increment(i integer) RETURNS integer AS $$
          BEGIN
            RETURN i + 1;
          END;
        $$ LANGUAGE plpgsql;
        SELECT increment(1);
      `;
    const stmts = splitSQLStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE OR REPLACE FUNCTION");
    expect(stmts[1]).toBe("SELECT increment(1)");
  });
});
