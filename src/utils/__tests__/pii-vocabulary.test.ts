import { describe, it, expect } from "vitest";
import vocab from "../pii-vocabulary.json" with { type: "json" };
import {
  findHardPiiMatchesInProjectionText,
  findClinicalMatchesInProjectionText,
  findPiiMatchesInProjectionText,
} from "../pii-heuristics.js";

/**
 * Drift guard: the canonical vocabulary JSON (shared with CongoSky's pii-firewall)
 * must stay behaviorally faithful to the live TypeScript guard. Every term the
 * catalog claims is hard-PII / clinical / overridable must actually be detected
 * as such by the guard. If a term is added to the guard but not the catalog (or
 * vice-versa, or reclassified), these assertions fail — coverage cannot silently
 * diverge between the two repos.
 */
describe("pii-vocabulary.json is faithful to the live guard", () => {
  const hardPii = Object.values(vocab.hard_pii).flat() as string[];
  const clinical = Object.values(vocab.clinical).flat() as string[];
  const overridable = vocab.overridable_mobile as string[];

  it("every hard_pii term is detected as hard PII", () => {
    const misses = hardPii.filter((t) => findHardPiiMatchesInProjectionText(t).length === 0);
    expect(misses, `hard_pii terms not detected by the guard: ${misses.join(", ")}`).toEqual([]);
  });

  it("every clinical term is detected as clinical health data", () => {
    const misses = clinical.filter((t) => findClinicalMatchesInProjectionText(t).length === 0);
    expect(misses, `clinical terms not detected by the guard: ${misses.join(", ")}`).toEqual([]);
  });

  it("every overridable term is detected as the overridable (mobile) class", () => {
    const misses = overridable.filter((t) => findPiiMatchesInProjectionText(t).length === 0);
    expect(misses, `overridable terms not detected: ${misses.join(", ")}`).toEqual([]);
  });

  it("overridable mobile terms are NOT classified as hard PII (the one exception holds)", () => {
    const leaked = overridable.filter((t) => findHardPiiMatchesInProjectionText(t).length > 0);
    expect(leaked, `mobile terms wrongly flagged as hard PII: ${leaked.join(", ")}`).toEqual([]);
  });

  it("safe_name_prefixes keep a *_name column non-personal", () => {
    const leaked = (vocab.safe_name_prefixes as string[]).filter(
      (p) => findHardPiiMatchesInProjectionText(`${p}_name`).length > 0
    );
    expect(leaked, `prefixes wrongly flagged personal: ${leaked.join(", ")}`).toEqual([]);
  });
});
