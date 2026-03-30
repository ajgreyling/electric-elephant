import {
  findPiiMatchesInProjectionText,
  projectionItemIsWildcard,
} from "./pii-heuristics.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

export type PiiGuardFailureReason =
  | "wildcard_projection"
  | "suspected_pii_or_clinical_column";

export type PiiGuardFailure = {
  ok: false;
  reason: PiiGuardFailureReason;
  matches: string[];
  message: string;
};

const MAX_NEST = 24;

function isKeywordAt(sql: string, i: number, keyword: string): boolean {
  const k = keyword.length;
  if (i + k > sql.length) { return false; }
  if (sql.slice(i, i + k).toLowerCase() !== keyword) { return false; }
  const before = i === 0 || !/[a-zA-Z0-9_]/.test(sql[i - 1]!);
  const after = i + k >= sql.length || !/[a-zA-Z0-9_]/.test(sql[i + k]!);
  return before && after;
}

function skipWhitespace(sql: string, i: number): number {
  let j = i;
  while (j < sql.length && /\s/.test(sql[j]!)) { j++; }
  return j;
}

/**
 * Comma-split at depth 0; respects parentheses.
 */
function isFullyWrappedInParens(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t[0] !== "(" || t[t.length - 1] !== ")") { return false; }
  let d = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") { d++; }
    else if (t[i] === ")") {
      d--;
      if (d === 0 && i < t.length - 1) { return false; }
    }
  }
  return d === 0;
}

function splitListItemsAtDepthZero(list: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === "(") { depth++; }
    else if (c === ")" && depth > 0) { depth--; }
    else if (c === "," && depth === 0) {
      items.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(list.slice(start).trim());
  return items.filter((x) => x.length > 0);
}

/**
 * From projection start, find exclusive end at top-level `FROM`, or EOS.
 */
function findSelectProjectionEnd(sql: string, projStart: number): number {
  let k = projStart;
  let d = 0;
  while (k < sql.length) {
    const ch = sql[k]!;
    if (ch === "(") { d++; k++; continue; }
    if (ch === ")") { d--; k++; continue; }
    if (d === 0 && isKeywordAt(sql, k, "from")) {
      return k;
    }
    k++;
  }
  return sql.length;
}

/** After RETURNING, list runs until `;` at depth zero or EOS (single-statement slice). */
function findReturningListEnd(sql: string, start: number): number {
  let k = start;
  let d = 0;
  while (k < sql.length) {
    const ch = sql[k]!;
    if (ch === "(") { d++; k++; continue; }
    if (ch === ")") { d--; k++; continue; }
    if (d === 0 && ch === ";") {
      return k;
    }
    k++;
  }
  return sql.length;
}

function skipSelectModifiers(sql: string, j: number): number {
  let p = skipWhitespace(sql, j);
  if (isKeywordAt(sql, p, "distinct")) {
    p = skipWhitespace(sql, p + 8);
  } else if (isKeywordAt(sql, p, "all")) {
    p = skipWhitespace(sql, p + 3);
  }
  return p;
}

/** Every SELECT in the statement (including subqueries and CTE bodies). */
function collectAllSelectProjections(sql: string): string[] {
  const projections: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (isKeywordAt(sql, i, "select")) {
      let j = i + 6;
      j = skipSelectModifiers(sql, j);
      const pe = findSelectProjectionEnd(sql, j);
      projections.push(sql.slice(j, pe).trim());
      i = pe;
      continue;
    }
    i++;
  }
  return projections;
}

function collectReturningProjectionsAtDepthZero(
  sql: string,
  rangeStart: number,
  rangeEnd: number
): string[] {
  const projections: string[] = [];
  let depth = 0;
  let i = rangeStart;
  while (i < rangeEnd) {
    const ch = sql[i]!;
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth--; i++; continue; }
    if (depth === 0 && isKeywordAt(sql, i, "returning")) {
      const j = skipWhitespace(sql, i + 9);
      const pe = Math.min(findReturningListEnd(sql, j), rangeEnd);
      projections.push(sql.slice(j, pe).trim());
      i = pe;
      continue;
    }
    i++;
  }
  return projections;
}

function analyzeProjectionListString(
  listStr: string,
  nest: number
): { wildcards: string[]; pii: string[] } {
  const wildcards: string[] = [];
  const pii: string[] = [];
  const items = splitListItemsAtDepthZero(listStr);
  for (const item of items) {
    if (projectionItemIsWildcard(item)) {
      wildcards.push(item.length > 80 ? `${item.slice(0, 77)}...` : item.trim());
      continue;
    }

    const trimmed = item.trim();
    if (nest < MAX_NEST && isFullyWrappedInParens(trimmed)) {
      const body = trimmed.slice(1, -1).trim();
      if (isKeywordAt(body, 0, "select")) {
        const nested = scanStatementInternal(body, nest + 1);
        wildcards.push(...nested.wildcards);
        for (const p of nested.pii) {
          if (!pii.includes(p)) { pii.push(p); }
        }
      }
    }

    const matches = findPiiMatchesInProjectionText(item);
    for (const m of matches) {
      if (!pii.includes(m)) { pii.push(m); }
    }
  }
  return { wildcards, pii };
}

function scanStatementInternal(
  strippedStmt: string,
  nest: number
): { wildcards: string[]; pii: string[] } {
  const allWild: string[] = [];
  const allPii: string[] = [];

  const selects = collectAllSelectProjections(strippedStmt);
  for (const rawList of selects) {
    const { wildcards, pii } = analyzeProjectionListString(rawList, nest);
    allWild.push(...wildcards);
    for (const p of pii) {
      if (!allPii.includes(p)) { allPii.push(p); }
    }
  }

  const returnings = collectReturningProjectionsAtDepthZero(
    strippedStmt,
    0,
    strippedStmt.length
  );
  for (const rawList of returnings) {
    const { wildcards, pii } = analyzeProjectionListString(rawList, nest);
    allWild.push(...wildcards);
    for (const p of pii) {
      if (!allPii.includes(p)) { allPii.push(p); }
    }
  }

  return {
    wildcards: [...new Set(allWild)].slice(0, 5),
    pii: allPii.slice(0, 5),
  };
}

function scanStatement(strippedStmt: string): { wildcards: string[]; pii: string[] } {
  return scanStatementInternal(strippedStmt, 0);
}

function buildRemediationMessage(
  reason: PiiGuardFailureReason,
  matches: string[]
): string {
  const matchHint =
    matches.length > 0 ? ` Examples: ${matches.join(", ")}.` : "";
  if (reason === "wildcard_projection") {
    return (
      `This query uses a wildcard projection (SELECT * or table.*), which is blocked when access to PII or sensitive clinical columns is not explicitly allowed.${matchHint} ` +
      `List only non-sensitive columns, or set allow_access_to_pii_data=true for this execute_sql tool in TOML (or the corresponding environment/CLI flag in single-source mode).`
    );
  }
  return (
    `This query selects output expressions that may include PII or sensitive clinical fields.${matchHint} ` +
    `Narrow the SELECT/RETURNING list to safe columns, or set allow_access_to_pii_data=true for this execute_sql tool in TOML (or the corresponding environment/CLI flag in single-source mode).`
  );
}

/**
 * When allowAccess is false, inspect SQL (comments/strings stripped for PostgreSQL) for wildcard projections
 * and heuristic PII/clinical identifiers in SELECT/RETURNING lists.
 */
export function validateSqlPiiAccessGuard(
  sql: string,
  allowAccess: boolean
): { ok: true } | PiiGuardFailure {
  if (allowAccess) {
    return { ok: true };
  }
  const statements = splitSQLStatements(sql);
  for (const stmt of statements) {
    const stripped = stripCommentsAndStrings(stmt);
    const { wildcards, pii } = scanStatement(stripped);
    if (wildcards.length > 0) {
      return {
        ok: false,
        reason: "wildcard_projection",
        matches: wildcards,
        message: buildRemediationMessage("wildcard_projection", wildcards),
      };
    }
    if (pii.length > 0) {
      return {
        ok: false,
        reason: "suspected_pii_or_clinical_column",
        matches: pii,
        message: buildRemediationMessage("suspected_pii_or_clinical_column", pii),
      };
    }
  }
  return { ok: true };
}
