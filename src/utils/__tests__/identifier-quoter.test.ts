import { describe, it, expect } from "vitest";
import { quoteIdentifier, quoteQualifiedIdentifier } from "../identifier-quoter.js";

describe("quoteIdentifier (PostgreSQL)", () => {
  it("should quote simple identifiers with double quotes", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
    expect(quoteIdentifier("my_table")).toBe('"my_table"');
  });

  it("should escape double quotes by doubling them", () => {
    expect(quoteIdentifier('table"name')).toBe('"table""name"');
  });

  it("should reject identifiers with control characters", () => {
    expect(() => quoteIdentifier("table\0name")).toThrow("control characters");
    expect(() => quoteIdentifier("table\nname")).toThrow("control characters");
    expect(() => quoteIdentifier("")).toThrow("empty");
  });
});

describe("quoteQualifiedIdentifier", () => {
  it("should quote table only when schema is not provided", () => {
    expect(quoteQualifiedIdentifier("users", undefined)).toBe('"users"');
  });

  it("should quote both schema and table when schema is provided", () => {
    expect(quoteQualifiedIdentifier("users", "public")).toBe('"public"."users"');
  });
});
