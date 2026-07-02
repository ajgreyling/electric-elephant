import {
  type ClinicalStandard,
  findClinicalMatchesInProjectionText,
  findHardPiiMatchesInProjectionText,
  findPiiMatchesInProjectionText,
  projectionItemIsWildcard,
  projectionItemIsWholeRowRisk,
} from "./pii-heuristics.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

export type PiiGuardFailureReason =
  | "wildcard_projection"
  | "wildcard_clinical_risk"
  | "suspected_pii_or_clinical_column"
  | "clinical_health_data_blocked"
  | "hard_pii_blocked";

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

/**
 * Collect table names and aliases referenced in FROM/JOIN clauses. A projection
 * item that is a bare identifier matching one of these is a whole-row RECORD
 * projection (e.g. `SELECT u FROM users u`) — it emits every column and cannot be
 * proven free of hard-excluded data.
 */
function collectRecordNames(sql: string): Set<string> {
  const names = new Set<string>();
  // Matches `FROM|JOIN <schema.>?table [AS] [alias]`, capturing table and optional alias.
  const re = /\b(?:from|join)\s+(?:only\s+)?(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  const RESERVED = new Set(["as", "on", "using", "where", "group", "order", "left", "right", "inner", "outer", "full", "cross", "join", "lateral", "natural"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const schema = m[1];
    const table = m[2]!;
    const alias = m[3];
    names.add(table.toLowerCase());
    if (schema) {
      names.add(`${schema.toLowerCase()}.${table.toLowerCase()}`);
    }
    if (alias && !RESERVED.has(alias.toLowerCase())) {
      names.add(alias.toLowerCase());
    }
  }
  return names;
}

/**
 * True if a projection item is a whole-row RECORD reference: a bare identifier
 * that names a FROM table/alias (e.g. `u` in `SELECT u FROM users u`), or a
 * schema-qualified table name (e.g. `public.users`). A trailing `.column` after
 * an alias is a normal scalar column and is NOT treated as a record here.
 */
function projectionItemIsRecordReference(item: string, recordNames: Set<string>): boolean {
  const t = item.trim().replace(/"/g, "");
  // Bare identifier matching a table/alias.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
    return recordNames.has(t.toLowerCase());
  }
  // schema.table form (e.g. public.users) where the table part is a known record.
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(t);
  if (m) {
    // Only flag when this exact schema.table appears as a FROM record (not an
    // alias.column projection). recordNames holds table names, so require the
    // table part to be a record AND the whole schema.table to be referenced.
    return recordNames.has(m[2]!.toLowerCase()) && recordNames.has(`${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`);
  }
  return false;
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

type ScanResult = {
  wildcards: string[];
  pii: string[];
  clinical: string[];
  hardPii: string[];
};

function pushUnique(target: string[], values: string[]): void {
  for (const v of values) {
    if (!target.includes(v)) { target.push(v); }
  }
}

function analyzeProjectionListString(
  listStr: string,
  nest: number,
  recordNames: Set<string>,
  enabledStandards?: ClinicalStandard[]
): ScanResult {
  const wildcards: string[] = [];
  const pii: string[] = [];
  const clinical: string[] = [];
  const hardPii: string[] = [];
  const items = splitListItemsAtDepthZero(listStr);
  for (const item of items) {
    if (
      projectionItemIsWildcard(item) ||
      projectionItemIsWholeRowRisk(item) ||
      projectionItemIsRecordReference(item, recordNames)
    ) {
      wildcards.push(item.length > 80 ? `${item.slice(0, 77)}...` : item.trim());
      continue;
    }

    const trimmed = item.trim();
    if (nest < MAX_NEST && isFullyWrappedInParens(trimmed)) {
      const body = trimmed.slice(1, -1).trim();
      if (isKeywordAt(body, 0, "select")) {
        const nested = scanStatementInternal(body, nest + 1, enabledStandards);
        wildcards.push(...nested.wildcards);
        pushUnique(pii, nested.pii);
        pushUnique(clinical, nested.clinical);
        pushUnique(hardPii, nested.hardPii);
      }
    }

    // Clinical/health data is hard-excluded and can never be unblocked.
    pushUnique(clinical, findClinicalMatchesInProjectionText(item));
    // Hard PII (names, email, national IDs, DOB, address, etc.) is also
    // hard-excluded — everything except mobile/phone.
    pushUnique(hardPii, findHardPiiMatchesInProjectionText(item));
    // The only overridable class is mobile/phone (the Helium username).
    pushUnique(pii, findPiiMatchesInProjectionText(item, enabledStandards));
  }
  return { wildcards, pii, clinical, hardPii };
}

function scanStatementInternal(
  strippedStmt: string,
  nest: number,
  enabledStandards?: ClinicalStandard[]
): ScanResult {
  const allWild: string[] = [];
  const allPii: string[] = [];
  const allClinical: string[] = [];
  const allHardPii: string[] = [];

  const recordNames = collectRecordNames(strippedStmt);
  const lists = [
    ...collectAllSelectProjections(strippedStmt),
    ...collectReturningProjectionsAtDepthZero(strippedStmt, 0, strippedStmt.length),
  ];
  for (const rawList of lists) {
    const { wildcards, pii, clinical, hardPii } = analyzeProjectionListString(
      rawList,
      nest,
      recordNames,
      enabledStandards
    );
    allWild.push(...wildcards);
    pushUnique(allPii, pii);
    pushUnique(allClinical, clinical);
    pushUnique(allHardPii, hardPii);
  }

  return {
    wildcards: [...new Set(allWild)].slice(0, 5),
    pii: allPii.slice(0, 5),
    clinical: allClinical.slice(0, 5),
    hardPii: allHardPii.slice(0, 5),
  };
}

function scanStatement(
  strippedStmt: string,
  enabledStandards?: ClinicalStandard[]
): ScanResult {
  return scanStatementInternal(strippedStmt, 0, enabledStandards);
}

function buildRemediationMessage(
  reason: PiiGuardFailureReason,
  matches: string[]
): string {
  const matchHint =
    matches.length > 0 ? ` Examples: ${matches.join(", ")}.` : "";
  if (reason === "clinical_health_data_blocked") {
    return (
      `This query projects clinical/health data (HL7v2, FHIR, LOINC, SNOMED, or medical fields), which is hard-excluded and can never be returned by this server.${matchHint} ` +
      `This block cannot be overridden by allow_access_to_pii_data or clinical_standards. Remove the clinical/health columns from the SELECT/RETURNING list.`
    );
  }
  if (reason === "hard_pii_blocked") {
    return (
      `This query projects personal data (e.g. name, email, national identifier, date of birth, address) that is hard-excluded and can never be returned by this server.${matchHint} ` +
      `Only the user's mobile/phone number is overridable via allow_access_to_pii_data. Remove these columns from the SELECT/RETURNING list.`
    );
  }
  if (reason === "wildcard_clinical_risk") {
    return (
      `This query uses a wildcard projection (SELECT * or table.*), which is blocked because it could expose hard-excluded clinical/health columns that cannot be statically ruled out.${matchHint} ` +
      `This block cannot be overridden. List only the specific non-clinical columns you need.`
    );
  }
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
 * Inspect SQL (comments/strings stripped for PostgreSQL) for clinical/health data,
 * hard PII, wildcard projections, and the single overridable identifier in
 * SELECT/RETURNING lists.
 *
 * HARD-EXCLUDED (always blocked, regardless of `allowAccess` / `enabledStandards`):
 *  - clinical/health data (HL7v2, FHIR, LOINC, SNOMED, medical heuristics)
 *  - generic PII: names, email, national identifiers, DOB, address, etc.
 *  - wildcard projections (they may hide any of the above)
 *
 * The ONLY thing `allowAccess` unblocks is the user's mobile/phone number — the
 * username on Helium. `enabledStandards` no longer relaxes anything.
 */
export function validateSqlPiiAccessGuard(
  sql: string,
  allowAccess: boolean,
  enabledStandards?: ClinicalStandard[]
): { ok: true } | PiiGuardFailure {
  const statements = splitSQLStatements(sql);
  for (const stmt of statements) {
    const stripped = stripCommentsAndStrings(stmt);
    const { wildcards, pii, clinical, hardPii } = scanStatement(stripped, enabledStandards);

    // Hard exclusion: clinical/health data is always blocked, even with access allowed.
    if (clinical.length > 0) {
      return {
        ok: false,
        reason: "clinical_health_data_blocked",
        matches: clinical,
        message: buildRemediationMessage("clinical_health_data_blocked", clinical),
      };
    }

    // Hard exclusion: personal data other than mobile/phone is always blocked.
    if (hardPii.length > 0) {
      return {
        ok: false,
        reason: "hard_pii_blocked",
        matches: hardPii,
        message: buildRemediationMessage("hard_pii_blocked", hardPii),
      };
    }

    // Hard exclusion: a wildcard projection can silently expose clinical/health
    // or personal columns that static analysis cannot inspect, so it is always
    // blocked and cannot be re-enabled by allow_access_to_pii_data.
    if (wildcards.length > 0) {
      return {
        ok: false,
        reason: "wildcard_clinical_risk",
        matches: wildcards,
        message: buildRemediationMessage("wildcard_clinical_risk", wildcards),
      };
    }

    // The only overridable class is mobile/phone (the Helium username).
    // Skipped when access is explicitly allowed.
    if (allowAccess) {
      continue;
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
