/**
 * Heuristic matching for suspected PII and sensitive clinical identifiers in SQL projections.
 * Used when execute_sql runs with allow_access_to_pii_data !== true (fail-closed default).
 */

const MAX_MATCHES = 5;
export type ClinicalStandard = "hl7v2" | "fhir" | "loinc" | "snomed";
export const DEFAULT_CLINICAL_STANDARDS: ClinicalStandard[] = ["hl7v2", "fhir", "loinc", "snomed"];

const BASE_DIRECT_PHRASES: string[] = [
  "identifier",
  "identifier fields",
  "patient id",
  "patient code",
  "hospital number",
  "hos number",
  "surname",
  "sex",
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
];

const DIRECT_PHRASES_BY_STANDARD: Record<ClinicalStandard, string[]> = {
  hl7v2: [
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
  "gene xpert",
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
  "hemoglobin a1c",
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
  "result for action",
  "result status",
  "result unit",
  "result comment",
  "result item",
  "result items",
  "test status",
  "test set",
  "authorised date",
  "authorized date",
  "order id",
  "barcode",
  "batch barcode",
  "tracking number",
  "hl7",
  "hl7 message",
  "hl7 message control id",
  "hl7messagecontrolid",
  "message control id",
  "messagecontrolid",
  "elz id",
  "elzid",
  "orderid",
  "batchbarcode",
  "patient location code",
  "testtype fields",
  ],
  fhir: [
    "resource type",
    "subject reference",
    "patient reference",
    "patient identifier",
    "observation",
    "observation code",
    "observation value",
    "condition code",
    "diagnostic report",
    "encounter reference",
    "performer reference",
    "specimen reference",
    "value quantity",
    "value codeable concept",
    "effective date time",
  ],
  loinc: [
    "loinc",
    "loinc code",
    "loinc number",
    "lab code",
    "observation code",
    "component code",
  ],
  snomed: [
    "snomed",
    "snomed ct",
    "concept id",
    "clinical finding",
    "problem code",
    "diagnosis code",
    "disorder code",
  ],
};

const BASE_MEDICAL_CONTEXT_TOKENS = [
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
  "identifier",
  "barcode",
  "batchbarcode",
  "orderid",
  "hl7",
  "messagecontrolid",
  "elzid",
  "eid",
  "patientcode",
  "patientid",
  "hos",
  "locationcode",
  "testtype",
  "resultforaction",
  "resultstatus",
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
  "chemotherapy",
  "radiotherapy",
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
  "arv",
  "antiretroviral",
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
];

const MEDICAL_CONTEXT_TOKENS_BY_STANDARD: Record<ClinicalStandard, string[]> = {
  hl7v2: [
    "hl7",
    "messagecontrolid",
    "elzid",
    "barcode",
    "batchbarcode",
    "orderid",
    "testtype",
    "resultforaction",
    "resultstatus",
  ],
  fhir: [
    "resource",
    "resourcetype",
    "subject",
    "reference",
    "observation",
    "condition",
    "encounter",
    "codeableconcept",
    "diagnosticreport",
  ],
  loinc: ["loinc", "loinccode", "component", "analyte"],
  snomed: ["snomed", "concept", "disorder", "finding", "procedure"],
};

const WEAK_PAIR_TOKENS = new Set(["result", "status", "note"]);

/**
 * Normalize for case-insensitive phrase/token matching (underscore/hyphen → space).
 */
export function normalizePiiMatchText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]{2,})([A-Z][a-z]+)/g, "$1 $2")
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

function weakPairMatch(norm: string, medicalContextTokens: Set<string>): boolean {
  const tokens = norm.split(/[^a-z0-9+]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  for (const w of WEAK_PAIR_TOKENS) {
    if (!tokenSet.has(w)) { continue; }
    for (const t of tokens) {
      if (t === w) { continue; }
      if (medicalContextTokens.has(t)) { return true; }
      for (const m of medicalContextTokens) {
        if (m.length > 2 && t.includes(m)) { return true; }
      }
    }
  }
  return false;
}

function getEnabledClinicalStandards(
  enabledStandards?: ClinicalStandard[]
): ClinicalStandard[] {
  if (!enabledStandards || enabledStandards.length === 0) {
    return [...DEFAULT_CLINICAL_STANDARDS];
  }
  return [...new Set(enabledStandards)];
}

function buildDirectPhrases(enabledStandards?: ClinicalStandard[]): string[] {
  const phrases: string[] = [...BASE_DIRECT_PHRASES];
  const active = getEnabledClinicalStandards(enabledStandards);
  for (const standard of active) {
    phrases.push(...DIRECT_PHRASES_BY_STANDARD[standard]);
  }
  return phrases;
}

function buildMedicalContextTokenSet(enabledStandards?: ClinicalStandard[]): Set<string> {
  const tokens = new Set(BASE_MEDICAL_CONTEXT_TOKENS);
  const active = getEnabledClinicalStandards(enabledStandards);
  for (const standard of active) {
    for (const token of MEDICAL_CONTEXT_TOKENS_BY_STANDARD[standard]) {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Returns up to MAX_MATCHES human-readable match hints for logging/JSON details.
 */
export function findPiiMatchesInProjectionText(
  text: string,
  enabledStandards?: ClinicalStandard[]
): string[] {
  const norm = normalizePiiMatchText(text);
  if (!norm) { return []; }
  const directPhrases = buildDirectPhrases(enabledStandards);
  const medicalContextTokens = buildMedicalContextTokenSet(enabledStandards);
  const matches: string[] = [];
  for (const phrase of directPhrases) {
    if (directPhraseMatch(norm, phrase)) {
      matches.push(phrase);
      if (matches.length >= MAX_MATCHES) { return matches; }
    }
  }
  if (weakPairMatch(norm, medicalContextTokens)) {
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
