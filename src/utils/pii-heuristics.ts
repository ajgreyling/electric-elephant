/**
 * Heuristic matching for suspected PII and sensitive clinical identifiers in SQL projections.
 *
 * Policy (see CLAUDE.md): health/clinical data and almost all PII are HARD-EXCLUDED
 * and can never be returned. The ONLY field the `allow_access_to_pii_data` override
 * unblocks is the user's mobile/phone number — this is the username on Helium.
 */

const MAX_MATCHES = 5;
export type ClinicalStandard = "hl7v2" | "fhir" | "loinc" | "snomed";
export const DEFAULT_CLINICAL_STANDARDS: ClinicalStandard[] = ["hl7v2", "fhir", "loinc", "snomed"];

/**
 * The ONLY overridable field class: mobile / phone number (the Helium username).
 * When allow_access_to_pii_data is enabled, projections matching these — and
 * nothing else — are permitted.
 */
const OVERRIDABLE_PHRASES: string[] = [
  "mobile",
  "mobile number",
  "mobile no",
  "phone",
  "phone number",
  "phone no",
  "cell",
  "cellphone",
  "cell phone",
  "msisdn",
  "contact number",
];

/**
 * Generic PII that is HARD-EXCLUDED (never overridable): names, email, national
 * identifiers, dates of birth, addresses, and other direct identifiers. Mobile /
 * phone is intentionally NOT here — it lives in OVERRIDABLE_PHRASES.
 */
const HARD_PII_PHRASES: string[] = [
  "identifier",
  "identifier fields",
  "patient id",
  "patient code",
  "hospital number",
  "hos number",
  "surname",
  "sex",
  "email",
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

/**
 * Clinical/health phrases and context tokens are hard-excluded: they are ALWAYS
 * evaluated across every clinical standard and can never be unblocked via
 * allow_access_to_pii_data or a narrowed clinical_standards list. These come from
 * the per-standard clinical sets plus the medical weak-pair context tokens.
 */
function buildAllClinicalPhrases(): string[] {
  const phrases: string[] = [];
  for (const standard of DEFAULT_CLINICAL_STANDARDS) {
    phrases.push(...DIRECT_PHRASES_BY_STANDARD[standard]);
  }
  return phrases;
}

function buildAllMedicalContextTokenSet(): Set<string> {
  const tokens = new Set(BASE_MEDICAL_CONTEXT_TOKENS);
  for (const standard of DEFAULT_CLINICAL_STANDARDS) {
    for (const token of MEDICAL_CONTEXT_TOKENS_BY_STANDARD[standard]) {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Returns up to MAX_MATCHES human-readable match hints for CLINICAL/HEALTH data
 * (HL7v2, FHIR, LOINC, SNOMED, and medical-context heuristics). This is the
 * hard-exclusion set: it always runs and always uses every clinical standard,
 * independent of allow_access_to_pii_data or clinical_standards configuration.
 */
export function findClinicalMatchesInProjectionText(text: string): string[] {
  const norm = normalizePiiMatchText(text);
  if (!norm) { return []; }
  const clinicalPhrases = buildAllClinicalPhrases();
  const medicalContextTokens = buildAllMedicalContextTokenSet();
  const matches: string[] = [];
  for (const phrase of clinicalPhrases) {
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
 * Returns up to MAX_MATCHES human-readable match hints for HARD-EXCLUDED generic
 * PII: names, email, national identifiers, dates of birth, addresses, and other
 * direct identifiers. This set can NEVER be unblocked by allow_access_to_pii_data.
 * Mobile / phone number is deliberately excluded here (see the overridable set).
 */
export function findHardPiiMatchesInProjectionText(text: string): string[] {
  const norm = normalizePiiMatchText(text);
  if (!norm) { return []; }
  // A projection that is the overridable mobile/phone field must not be counted
  // as hard PII, even if a substring coincidentally overlaps a hard phrase.
  if (isOverridableMobileText(norm)) { return []; }
  const matches: string[] = [];
  for (const phrase of HARD_PII_PHRASES) {
    if (directPhraseMatch(norm, phrase)) {
      matches.push(phrase);
      if (matches.length >= MAX_MATCHES) { return matches; }
    }
  }
  return matches;
}

function isOverridableMobileText(norm: string): boolean {
  for (const phrase of OVERRIDABLE_PHRASES) {
    if (directPhraseMatch(norm, phrase)) { return true; }
  }
  return false;
}

/**
 * Returns match hints for the ONLY overridable PII class: mobile / phone number
 * (the Helium username). This is evaluated only to permit these fields when
 * allow_access_to_pii_data is enabled; every other identifier stays hard-excluded.
 *
 * The `_enabledStandards` parameter is retained for signature compatibility and
 * is unused (clinical standards never affect this set).
 */
export function findPiiMatchesInProjectionText(
  text: string,
  _enabledStandards?: ClinicalStandard[]
): string[] {
  const norm = normalizePiiMatchText(text);
  if (!norm) { return []; }
  const matches: string[] = [];
  for (const phrase of OVERRIDABLE_PHRASES) {
    if (directPhraseMatch(norm, phrase)) {
      matches.push(phrase);
      if (matches.length >= MAX_MATCHES) { return matches; }
    }
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
