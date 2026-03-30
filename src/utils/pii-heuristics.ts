/**
 * Heuristic matching for suspected PII and sensitive clinical identifiers in SQL projections.
 * Used when execute_sql runs with allow_access_to_pii_data !== true (fail-closed default).
 */

const MAX_MATCHES = 5;

/** Multi-word and single-word phrases (normalized with space separators). */
const DIRECT_PHRASES: string[] = [
  "email",
  "phone",
  "mobile",
  "ssn",
  "tax id",
  "passport",
  "national id",
  "id number",
  "first name",
  "last name",
  "full name",
  "dob",
  "birth date",
  "address",
  // Infectious / highly stigmatized clinical
  "hiv",
  "hiv result",
  "hiv test",
  "hiv status",
  "aids",
  "tb",
  "tuberculosis",
  "tb result",
  "tb test",
  "tb status",
  "mantoux",
  "quantiferon",
  "gene expert",
  "genexpert",
  "viral load",
  "cd4",
  "arv",
  "antiretroviral",
  // Labs / blood work and pathology
  "lab result",
  "test result",
  "blood result",
  "blood test",
  "blood glucose",
  "blood count",
  "blood gas",
  "blood type",
  "hemoglobin",
  "hematocrit",
  "platelet",
  "creatinine",
  "hba1c",
  "a1c",
  "cbc",
  "cmp",
  "bmp",
  "inr",
  "serology",
  "pathology",
  "histology",
  "cytology",
  "biopsy",
  "culture result",
  "sensitivity report",
  "specimen id",
  "urinalysis",
  // Clinical documentation and problem lists
  "diagnosis",
  "comorbidity",
  "problem list",
  "chief complaint",
  "progress note",
  "chart note",
  "clinical note",
  "clinical status",
  "discharge summary",
  "admission note",
  "physical exam",
  "family history",
  "social history",
  "surgical history",
  "medication list",
  "prescription",
  "immunization",
  "vaccination record",
  "allergy",
  "allergies",
  "screening result",
  "infection status",
];

const MEDICAL_CONTEXT_TOKENS = new Set([
  "lab",
  "test",
  "diagnosis",
  "diagnostic",
  "screening",
  "infection",
  "infect",
  "clinical",
  "hiv",
  "tb",
  "tuberculosis",
  "viral",
  "cd4",
  "specimen",
  "patient",
  "medical",
  "medic",
  "pathology",
  "serology",
  "antibody",
  "antigen",
  "blood",
  "hemoglobin",
  "hematocrit",
  "platelet",
  "glucose",
  "creatinine",
  "histology",
  "cytology",
  "biopsy",
  "oncology",
  "radiology",
  "histopath",
  "bacteriology",
  "virology",
  "immunology",
  "hematology",
  "mycobacterium",
  "sputum",
  "csf",
  "pcr",
  "arb",
  "arv",
  "antiretroviral",
  "therapy",
  "chemo",
  "culture",
  "smear",
  "genexpert",
  "prescription",
  "allergy",
  "allergies",
  "immunization",
  "vaccine",
  "comorbid",
  "morbidity",
  "prognosis",
  "symptom",
  "icu",
  "inpatient",
  "outpatient",
]);

const WEAK_PAIR_TOKENS = new Set(["result", "status", "note"]);

/**
 * Normalize for case-insensitive phrase/token matching (underscore/hyphen → space).
 */
export function normalizePiiMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function directPhraseMatch(norm: string, phrase: string): boolean {
  const padded = ` ${norm} `;
  if (phrase.includes(" ")) {
    return padded.includes(` ${phrase} `);
  }
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`, "i");
  return re.test(norm);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function weakPairMatch(norm: string): boolean {
  const tokens = norm.split(/[^a-z0-9+]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  for (const w of WEAK_PAIR_TOKENS) {
    if (!tokenSet.has(w)) { continue; }
    for (const t of tokens) {
      if (t === w) { continue; }
      if (MEDICAL_CONTEXT_TOKENS.has(t)) { return true; }
      for (const m of MEDICAL_CONTEXT_TOKENS) {
        if (m.length > 2 && t.includes(m)) { return true; }
      }
    }
  }
  return false;
}

/**
 * Returns up to MAX_MATCHES human-readable match hints for logging/JSON details.
 */
export function findPiiMatchesInProjectionText(text: string): string[] {
  const norm = normalizePiiMatchText(text);
  if (!norm) { return []; }
  const matches: string[] = [];
  for (const phrase of DIRECT_PHRASES) {
    if (directPhraseMatch(norm, phrase)) {
      matches.push(phrase);
      if (matches.length >= MAX_MATCHES) { return matches; }
    }
  }
  if (weakPairMatch(norm)) {
    matches.push("context:weak_token+medical_context");
    if (matches.length >= MAX_MATCHES) { return matches; }
  }
  return matches;
}

/**
 * True if this single SELECT/RETURNING item is a wildcard projection.
 */
export function projectionItemIsWildcard(item: string): boolean {
  const t = item.trim();
  if (t === "*") { return true; }
  if (/\.\s*\*\s*$/.test(t)) { return true; }
  return false;
}
