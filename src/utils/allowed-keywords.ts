import { stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Allowed leading keywords for read-only SQL (PostgreSQL).
 */
export const allowedKeywords: string[] = ["select", "with", "explain", "show"];

/**
 * Keywords that indicate data-modifying operations.
 * Used to detect DML/DDL hidden inside CTEs or other constructs.
 */
const mutatingKeywords = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "merge",
  "grant",
  "revoke",
  "rename",
];

const mutatingPattern = new RegExp(
  `\\b(?:${mutatingKeywords.join("|")})\\b`,
  "i",
);

const selectIntoPattern = /\bselect\b[\s\S]+\binto\b/i;

/** Matches EXPLAIN ANALYZE (or parenthesized form), excluding disabled forms (false/off/0) */
const explainAnalyzePattern =
  /^explain\s+(?:\([^)]*\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)[^)]*\)|\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)(?:\s+verbose\b)?)/i;

/**
 * Check if a SQL query is read-only (PostgreSQL).
 */
export function isReadOnlySQL(sql: string): boolean {
  return checkReadOnly(stripCommentsAndStrings(sql).trim().toLowerCase());
}

function checkReadOnly(cleanedSQL: string): boolean {
  if (!cleanedSQL) {
    return false;
  }

  const firstWord = cleanedSQL.match(/\S+/)?.[0] ?? "";

  if (!allowedKeywords.includes(firstWord)) {
    return false;
  }

  if (firstWord === "with") {
    if (mutatingPattern.test(cleanedSQL)) {
      return false;
    }
  }

  if ((firstWord === "select" || firstWord === "with") && selectIntoPattern.test(cleanedSQL)) {
    return false;
  }

  if (firstWord === "explain") {
    const m = explainAnalyzePattern.exec(cleanedSQL);
    if (m) {
      const afterExplain = cleanedSQL.slice(m[0].length).trim();
      if (afterExplain && !checkReadOnly(afterExplain)) {
        return false;
      }
    }
  }

  return true;
}
