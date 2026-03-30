import { describe, it, expect } from "vitest";
import {
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

  describe("findPiiMatchesInProjectionText", () => {
    it("matches identity and contact tokens", () => {
      expect(findPiiMatchesInProjectionText("email")).toContain("email");
      expect(findPiiMatchesInProjectionText("user_email")).toContain("email");
      expect(findPiiMatchesInProjectionText("tax_id")).toContain("tax id");
    });

    it("matches HIV/TB and related infectious-disease markers", () => {
      expect(findPiiMatchesInProjectionText("hiv_status")).toContain("hiv status");
      expect(findPiiMatchesInProjectionText("hiv_result")).toContain("hiv result");
      expect(findPiiMatchesInProjectionText("HIVResult")).toContain("hiv result");
      expect(findPiiMatchesInProjectionText("tb_screen")).toContain("tb");
      expect(findPiiMatchesInProjectionText("GeneXpert_Result")).toContain("gene xpert");
    });

    it("matches blood work and common lab panels", () => {
      expect(findPiiMatchesInProjectionText("blood_glucose")).toContain("blood glucose");
      expect(findPiiMatchesInProjectionText("hemoglobin_a1c")).toContain("hemoglobin a1c");
      expect(findPiiMatchesInProjectionText("platelet_count")).toContain("platelet");
    });

    it("matches structured clinical documentation phrases", () => {
      expect(findPiiMatchesInProjectionText("chief_complaint")).toContain("chief complaint");
      expect(findPiiMatchesInProjectionText("progress_note_text")).toContain("progress note");
    });

    it("uses weak token pairing only with medical context", () => {
      expect(findPiiMatchesInProjectionText("order_status")).toEqual([]);
      expect(findPiiMatchesInProjectionText("patient_status")).toContain("context:weak_token+medical_context");
      expect(findPiiMatchesInProjectionText("lab_result")).toContain("lab result");
    });

    it("does not treat bare status as sensitive without context", () => {
      expect(findPiiMatchesInProjectionText("status_code")).toEqual([]);
    });
  });
});
