import { describe, it, expect } from "vitest";
import {
  findClinicalMatchesInProjectionText,
  findHardPiiMatchesInProjectionText,
  findPiiMatchesInProjectionText,
  normalizePiiMatchText,
  projectionItemIsWildcard,
} from "../pii-heuristics.js";

describe("pii-heuristics", () => {
  describe("normalizePiiMatchText", () => {
    it("normalizes separators to spaces", () => {
      expect(normalizePiiMatchText("Blood_Glucose")).toBe("blood glucose");
      expect(normalizePiiMatchText("  EMAIL-ADDR ")).toBe("email addr");
    });
  });

  describe("projectionItemIsWildcard", () => {
    it("detects SELECT * style wildcards", () => {
      expect(projectionItemIsWildcard("*")).toBe(true);
      expect(projectionItemIsWildcard("  u.* ")).toBe(true);
      expect(projectionItemIsWildcard("public.users.*")).toBe(true);
    });
    it("does not flag count(*)", () => {
      expect(projectionItemIsWildcard("count(*)")).toBe(false);
    });
  });

  describe("findPiiMatchesInProjectionText (overridable: mobile/phone only)", () => {
    it("matches mobile / phone number columns (the Helium username)", () => {
      expect(findPiiMatchesInProjectionText("mobile")).toContain("mobile");
      expect(findPiiMatchesInProjectionText("mobile_number")).toContain("mobile number");
      expect(findPiiMatchesInProjectionText("phone")).toContain("phone");
      expect(findPiiMatchesInProjectionText("phone_number")).toContain("phone number");
      expect(findPiiMatchesInProjectionText("cellphone")).toContain("cellphone");
      expect(findPiiMatchesInProjectionText("msisdn")).toContain("msisdn");
    });

    it("does NOT classify other PII as overridable", () => {
      // Everything except mobile/phone is hard PII, handled elsewhere.
      expect(findPiiMatchesInProjectionText("email")).toEqual([]);
      expect(findPiiMatchesInProjectionText("first_name")).toEqual([]);
      expect(findPiiMatchesInProjectionText("tax_id")).toEqual([]);
      expect(findPiiMatchesInProjectionText("address")).toEqual([]);
    });

    it("does not classify clinical/health fields as overridable", () => {
      expect(findPiiMatchesInProjectionText("blood_glucose")).toEqual([]);
      expect(findPiiMatchesInProjectionText("hl7messagecontrolid")).toEqual([]);
      expect(findPiiMatchesInProjectionText("loinc_code")).toEqual([]);
    });

    it("does not treat bare status as sensitive", () => {
      expect(findPiiMatchesInProjectionText("status_code")).toEqual([]);
      expect(findPiiMatchesInProjectionText("order_status")).toEqual([]);
    });
  });

  describe("findHardPiiMatchesInProjectionText (hard-excluded identifiers)", () => {
    it("matches names, email, national identifiers, DOB, and address", () => {
      expect(findHardPiiMatchesInProjectionText("email")).toContain("email");
      expect(findHardPiiMatchesInProjectionText("user_email")).toContain("email");
      expect(findHardPiiMatchesInProjectionText("first_name")).toContain("first name");
      expect(findHardPiiMatchesInProjectionText("surname")).toContain("surname");
      expect(findHardPiiMatchesInProjectionText("tax_id")).toContain("tax id");
      expect(findHardPiiMatchesInProjectionText("national_id")).toContain("national id");
      expect(findHardPiiMatchesInProjectionText("dob")).toContain("dob");
      expect(findHardPiiMatchesInProjectionText("home_address")).toContain("address");
      expect(findHardPiiMatchesInProjectionText("hos_number")).toContain("hos number");
    });

    it("matches government IDs, financial, demographics, location, device, media, and secrets", () => {
      const mustBlock = [
        // government / national IDs
        "passport_no", "id_no", "identity_number", "drivers_license", "vat_number", "tax_number", "voter_id",
        // financial
        "credit_card", "card_number", "iban", "bank_account", "account_number", "cvv", "sort_code",
        // demographics / special category
        "race", "ethnicity", "religion", "nationality", "citizenship", "marital_status", "sexual_orientation",
        // dates of birth / age
        "birthday", "birth_year", "age",
        // address / location
        "street_address", "postal_code", "zip_code", "city", "province", "latitude", "longitude", "gps",
        // device / online identifiers
        "ip_address", "mac_address", "device_id", "imei", "fingerprint", "biometric",
        // media
        "avatar", "profile_picture", "selfie", "signature",
        // credentials / secrets
        "password", "password_hash", "api_key", "access_token", "session_token", "private_key", "client_secret", "otp",
        // contacts
        "next_of_kin", "emergency_contact", "guardian_name",
      ];
      for (const col of mustBlock) {
        expect(findHardPiiMatchesInProjectionText(col), `${col} should be hard PII`).not.toEqual([]);
      }
    });

    it("flags bare and compound personal-name columns", () => {
      expect(findHardPiiMatchesInProjectionText("name")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("full_name")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("fullName")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("firstName")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("customer_name")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("employee_name")).toContain("name");
      expect(findHardPiiMatchesInProjectionText("display_name")).toContain("name");
    });

    it("does NOT flag non-personal *_name columns", () => {
      for (const c of [
        "table_name",
        "column_name",
        "file_name",
        "product_name",
        "company_name",
        "event_name",
        "schema_name",
        "role_name",
        "user_name",
        "username",
        "host_name",
        "domain_name",
        "index_name",
        "tag_name",
        "brand_name",
      ]) {
        expect(findHardPiiMatchesInProjectionText(c)).toEqual([]);
      }
    });

    it("does NOT flag mobile/phone as hard PII (that is the overridable field)", () => {
      expect(findHardPiiMatchesInProjectionText("mobile")).toEqual([]);
      expect(findHardPiiMatchesInProjectionText("mobile_number")).toEqual([]);
      expect(findHardPiiMatchesInProjectionText("phone")).toEqual([]);
      expect(findHardPiiMatchesInProjectionText("cellphone")).toEqual([]);
    });

    it("does not flag benign columns", () => {
      const benign = [
        "status_code", "created_at", "updated_at", "id", "uuid", "user_id",
        "product_id", "status", "total", "amount", "price", "quantity", "count",
        "title", "description", "label", "slug", "sku", "category", "department",
        "state", "country_code", "currency", "language", "locale", "timezone",
        "page_count", "capacity", "subject", "priority", "severity", "score",
        "rating", "version", "type", "kind", "color", "size", "weight", "height",
        "width", "duration", "start_date", "end_date", "due_date",
      ];
      for (const col of benign) {
        expect(findHardPiiMatchesInProjectionText(col), `${col} should be allowed`).toEqual([]);
      }
    });
  });

  describe("findClinicalMatchesInProjectionText (hard-excluded health data)", () => {
    it("matches HIV/TB and related infectious-disease markers", () => {
      expect(findClinicalMatchesInProjectionText("hiv_status")).toContain("hiv status");
      expect(findClinicalMatchesInProjectionText("hiv_result")).toContain("hiv result");
      expect(findClinicalMatchesInProjectionText("HIVResult")).toContain("hiv result");
      expect(findClinicalMatchesInProjectionText("tb_screen")).toContain("tb");
      expect(findClinicalMatchesInProjectionText("GeneXpert_Result")).toContain("gene xpert");
    });

    it("matches blood work and common lab panels", () => {
      expect(findClinicalMatchesInProjectionText("blood_glucose")).toContain("blood glucose");
      expect(findClinicalMatchesInProjectionText("hemoglobin_a1c")).toContain("hemoglobin a1c");
      expect(findClinicalMatchesInProjectionText("platelet_count")).toContain("platelet");
      expect(findClinicalMatchesInProjectionText("result_status")).toContain("result status");
    });

    it("matches eLabs HL7 and LIS projection names", () => {
      expect(findClinicalMatchesInProjectionText("hl7messagecontrolid")).toContain("hl7messagecontrolid");
      expect(findClinicalMatchesInProjectionText("elzId")).toContain("elz id");
      expect(findClinicalMatchesInProjectionText("orderID")).toContain("order id");
      expect(findClinicalMatchesInProjectionText("testtype_fields")).toContain("testtype fields");
      expect(findClinicalMatchesInProjectionText("resultForAction")).toContain("result for action");
    });

    it("matches FHIR/LOINC/SNOMED projection names", () => {
      expect(findClinicalMatchesInProjectionText("subject_reference")).toContain("subject reference");
      expect(findClinicalMatchesInProjectionText("loinc_code")).toContain("loinc code");
      expect(findClinicalMatchesInProjectionText("snomed_ct_code")).toContain("snomed ct");
    });

    it("is standard-independent: every clinical standard is always evaluated", () => {
      // Unlike the old soft guard, clinical detection cannot be narrowed away by
      // configuring clinical_standards — HL7v2, FHIR, LOINC, and SNOMED all match.
      expect(findClinicalMatchesInProjectionText("subject_reference")).not.toEqual([]);
      expect(findClinicalMatchesInProjectionText("loinc_code")).not.toEqual([]);
      expect(findClinicalMatchesInProjectionText("snomed_ct_code")).not.toEqual([]);
      expect(findClinicalMatchesInProjectionText("hl7messagecontrolid")).not.toEqual([]);
    });

    it("matches structured clinical documentation phrases", () => {
      expect(findClinicalMatchesInProjectionText("chief_complaint")).toContain("chief complaint");
      expect(findClinicalMatchesInProjectionText("progress_note_text")).toContain("progress note");
    });

    it("uses weak token pairing only with medical context", () => {
      expect(findClinicalMatchesInProjectionText("order_status")).toEqual([]);
      expect(findClinicalMatchesInProjectionText("patient_status")).toContain(
        "context:weak_token+medical_context"
      );
      expect(findClinicalMatchesInProjectionText("lab_result")).toContain("lab result");
    });

    it("does not treat bare status as clinical without context", () => {
      expect(findClinicalMatchesInProjectionText("status_code")).toEqual([]);
    });
  });
});
