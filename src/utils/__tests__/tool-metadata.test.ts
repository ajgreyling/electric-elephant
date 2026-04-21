import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchDatabaseObjectsSchema } from "../../tools/search-objects.js";
import { buildSourceDescriptionPrefix, getToolsForSource } from "../tool-metadata.js";
import { ConnectorManager } from "../../connectors/manager.js";
import { getToolRegistry } from "../../tools/registry.js";

vi.mock("../../connectors/manager.js");
vi.mock("../../tools/registry.js");

describe("tool metadata", () => {
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  beforeEach(() => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(["default"]);
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({
      id: "default",
      type: "postgres",
      dsn: "postgres://example",
    } as any);
    mockGetToolRegistry.mockReturnValue({
      getEnabledToolConfigs: vi.fn().mockReturnValue([{ name: "search_objects" }]),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts function object type in search_objects schema", () => {
    const parsed = searchDatabaseObjectsSchema.object_type.safeParse("function");
    expect(parsed.success).toBe(true);
  });

  it("includes table filter parameter in search_objects metadata", () => {
    const tools = getToolsForSource("default");
    const searchObjects = tools.find((tool) => tool.name === "search_objects");

    expect(searchObjects).toBeDefined();
    expect(searchObjects?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "table",
          required: false,
          description: expect.stringContaining("column/index only"),
        }),
      ])
    );
  });

  it("documents function support in search_objects metadata description", () => {
    const tools = getToolsForSource("default");
    const searchObjects = tools.find((tool) => tool.name === "search_objects");

    expect(searchObjects?.description).toContain("functions");
  });
});

describe("buildSourceDescriptionPrefix", () => {
  it("returns empty string when description is undefined", () => {
    expect(buildSourceDescriptionPrefix(undefined)).toBe("");
  });

  it("returns empty string when description is empty", () => {
    expect(buildSourceDescriptionPrefix("")).toBe("");
  });

  it("returns empty string when description is whitespace-only", () => {
    expect(buildSourceDescriptionPrefix("   ")).toBe("");
    expect(buildSourceDescriptionPrefix("\t\n")).toBe("");
  });

  it("appends '. ' when description has no sentence-ending punctuation", () => {
    expect(buildSourceDescriptionPrefix("Prod DB")).toBe("Prod DB. ");
  });

  it("appends only a space when description already ends with punctuation", () => {
    expect(buildSourceDescriptionPrefix("Prod DB.")).toBe("Prod DB. ");
    expect(buildSourceDescriptionPrefix("Production DB!")).toBe("Production DB! ");
    expect(buildSourceDescriptionPrefix("Query me?")).toBe("Query me? ");
    expect(buildSourceDescriptionPrefix("Details below:")).toBe("Details below: ");
  });

  it("trims surrounding whitespace before assessing punctuation", () => {
    expect(buildSourceDescriptionPrefix("  Prod DB  ")).toBe("Prod DB. ");
    expect(buildSourceDescriptionPrefix("  Prod DB.  ")).toBe("Prod DB. ");
  });

  it("preserves internal whitespace and punctuation", () => {
    expect(buildSourceDescriptionPrefix("Line 1\nLine 2")).toBe("Line 1\nLine 2. ");
    expect(buildSourceDescriptionPrefix("Line A, Line B")).toBe("Line A, Line B. ");
  });

  it("does not treat non-sentence-ending punctuation as terminators", () => {
    expect(buildSourceDescriptionPrefix("(read-only)")).toBe("(read-only). ");
    expect(buildSourceDescriptionPrefix("Clause 1; clause 2")).toBe("Clause 1; clause 2. ");
  });
});
