import { stripCommentsStringsAndIdentifiers } from "./sql-parser.js";

/**
 * Apply row limits to SELECT queries using PostgreSQL LIMIT.
 */
export class SQLRowLimiter {
  /**
   * Check if a SQL statement is a SELECT query that can benefit from row limiting
   * Only handles SELECT queries
   */
  static isSelectQuery(sql: string): boolean {
    const trimmed = sql.trim().toLowerCase();
    return trimmed.startsWith("select");
  }

  /**
   * Check if a SQL statement already has a LIMIT clause.
   * Strips comments and string literals first to avoid false positives.
   */
  static hasLimitClause(sql: string): boolean {
    const cleanedSQL = stripCommentsStringsAndIdentifiers(sql);
    const limitRegex = /\blimit\s+(?:\d+|\$\d+)/i;
    return limitRegex.test(cleanedSQL);
  }

  /**
   * Extract existing LIMIT value from SQL if present.
   * Strips comments and string literals first to avoid false positives.
   */
  static extractLimitValue(sql: string): number | null {
    const cleanedSQL = stripCommentsStringsAndIdentifiers(sql);
    const limitMatch = cleanedSQL.match(/\blimit\s+(\d+)/i);
    if (limitMatch) {
      return parseInt(limitMatch[1], 10);
    }
    return null;
  }

  /**
   * Add or modify LIMIT clause in a SQL statement
   */
  static applyLimitToQuery(sql: string, maxRows: number): string {
    const existingLimit = this.extractLimitValue(sql);

    if (existingLimit !== null) {
      const effectiveLimit = Math.min(existingLimit, maxRows);
      return sql.replace(/\blimit\s+\d+/i, `LIMIT ${effectiveLimit}`);
    }

    const trimmed = sql.trim();
    const hasSemicolon = trimmed.endsWith(";");
    const sqlWithoutSemicolon = hasSemicolon ? trimmed.slice(0, -1) : trimmed;

    return `${sqlWithoutSemicolon} LIMIT ${maxRows}${hasSemicolon ? ";" : ""}`;
  }

  /**
   * Check if a LIMIT clause uses a PostgreSQL parameter placeholder (not a literal number).
   */
  static hasParameterizedLimit(sql: string): boolean {
    const cleanedSQL = stripCommentsStringsAndIdentifiers(sql);
    return /\blimit\s+\$\d+/i.test(cleanedSQL);
  }

  /**
   * Apply maxRows limit to a SELECT query only.
   *
   * For parameterized LIMIT (e.g. LIMIT $1), wrap the query in a subquery so max_rows
   * remains a hard cap when the parameter is bound at runtime.
   */
  static applyMaxRows(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql)) {
      return sql;
    }

    if (this.hasParameterizedLimit(sql)) {
      const trimmed = sql.trim();
      const hasSemicolon = trimmed.endsWith(";");
      const sqlWithoutSemicolon = hasSemicolon ? trimmed.slice(0, -1) : trimmed;
      return `SELECT * FROM (${sqlWithoutSemicolon}) AS subq LIMIT ${maxRows}${hasSemicolon ? ";" : ""}`;
    }

    return this.applyLimitToQuery(sql, maxRows);
  }
}
