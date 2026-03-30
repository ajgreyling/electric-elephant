import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSchemaDiffToolHandler } from "../schema-diff.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { Connector, ConnectorType, TableColumn } from "../../connectors/interface.js";

vi.mock("../../connectors/manager.js");

const createMockConnector = (id: ConnectorType = "postgres"): Connector => ({
  id,
  name: "Mock Connector",
  getId: () => "default",
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  tableExists: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
});

const parseToolResponse = (response: any) => JSON.parse(response.content[0].text);

describe("schema_diff tool", () => {
  const mockGetAvailableSourceIds = vi.mocked(ConnectorManager.getAvailableSourceIds);
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockEnsureConnected = vi.mocked(ConnectorManager.ensureConnected);

  beforeEach(() => {
    mockEnsureConnected.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("errors when fewer than two sources are configured", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["only_one"]);

    const handler = createSchemaDiffToolHandler("only_one");
    const result = await handler({ right_source: "other" }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("SCHEMA_DIFF_INSUFFICIENT_SOURCES");
  });

  it("errors when right_source equals left source", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["a", "b"]);

    const handler = createSchemaDiffToolHandler("a");
    const result = await handler({ right_source: "a" }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("SCHEMA_DIFF_INVALID_SOURCES");
  });

  it("errors when right_source is unknown", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["a", "b"]);

    const handler = createSchemaDiffToolHandler("a");
    const result = await handler({ right_source: "zzz" }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("SCHEMA_DIFF_UNKNOWN_SOURCE");
  });

  it("reports table-only differences for a shared schema", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();

    vi.mocked(left.getSchemas).mockResolvedValue(["public", "pg_catalog"]);
    vi.mocked(right.getSchemas).mockResolvedValue(["public", "pg_catalog"]);

    vi.mocked(left.getTables).mockResolvedValue(["keep", "only_left"]);
    vi.mocked(right.getTables).mockResolvedValue(["keep", "only_right"]);

    const colKeep: TableColumn[] = [
      {
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
        column_default: null,
        description: null,
      },
    ];
    vi.mocked(left.getTableSchema).mockResolvedValue(colKeep);
    vi.mocked(right.getTableSchema).mockResolvedValue(colKeep);

    vi.mocked(left.getTableIndexes).mockResolvedValue([]);
    vi.mocked(right.getTableIndexes).mockResolvedValue([]);

    mockGetCurrentConnector.mockImplementation((sid?: string) => {
      if (sid === "right") {
        return right;
      }
      return left;
    });

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler(
      {
        right_source: "right",
        schema: "public",
        object_types: ["table", "column", "index"],
      },
      null
    );
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.left_source).toBe("left");
    expect(parsed.data.right_source).toBe("right");
    const td = parsed.data.table_diffs.find((x: any) => x.schema === "public");
    expect(td).toBeDefined();
    expect(td.only_in_left).toContain("only_left");
    expect(td.only_in_right).toContain("only_right");
  });

  it("reports column mismatch for common tables", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();

    vi.mocked(left.getSchemas).mockResolvedValue(["app"]);
    vi.mocked(right.getSchemas).mockResolvedValue(["app"]);

    vi.mocked(left.getTables).mockResolvedValue(["t1"]);
    vi.mocked(right.getTables).mockResolvedValue(["t1"]);

    vi.mocked(left.getTableSchema).mockResolvedValue([
      {
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
        column_default: null,
        description: null,
      },
    ]);
    vi.mocked(right.getTableSchema).mockResolvedValue([
      {
        column_name: "id",
        data_type: "bigint",
        is_nullable: "NO",
        column_default: null,
        description: null,
      },
    ]);

    vi.mocked(left.getTableIndexes).mockResolvedValue([]);
    vi.mocked(right.getTableIndexes).mockResolvedValue([]);

    mockGetCurrentConnector.mockImplementation((sid?: string) => (sid === "right" ? right : left));

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler(
      {
        right_source: "right",
        schema: "app",
        object_types: ["column"],
      },
      null
    );
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.column_diffs.some((c: any) => c.change === "column_changed" && c.name === "id")).toBe(
      true
    );
  });

  it("rejects non-postgres connector", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();
    (right as { id: string }).id = "other";

    mockGetCurrentConnector.mockImplementation((sid?: string) => (sid === "right" ? right : left));

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler({ right_source: "right" }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("UNSUPPORTED_DATABASE");
  });

  it("reports user schema only on left when object_types includes schema", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();

    vi.mocked(left.getSchemas).mockResolvedValue(["app", "public"]);
    vi.mocked(right.getSchemas).mockResolvedValue(["public"]);
    vi.mocked(left.getTables).mockResolvedValue([]);
    vi.mocked(right.getTables).mockResolvedValue([]);

    mockGetCurrentConnector.mockImplementation((sid?: string) => (sid === "right" ? right : left));

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler(
      {
        right_source: "right",
        object_types: ["schema"],
      },
      null
    );
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.schemas.only_in_left).toContain("app");
    expect(parsed.data.schemas.only_in_right).toEqual([]);
  });

  it("reports index present only on one side", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();

    vi.mocked(left.getSchemas).mockResolvedValue(["public"]);
    vi.mocked(right.getSchemas).mockResolvedValue(["public"]);

    vi.mocked(left.getTables).mockResolvedValue(["t1"]);
    vi.mocked(right.getTables).mockResolvedValue(["t1"]);

    vi.mocked(left.getTableSchema).mockResolvedValue([]);
    vi.mocked(right.getTableSchema).mockResolvedValue([]);

    vi.mocked(left.getTableIndexes).mockResolvedValue([]);
    vi.mocked(right.getTableIndexes).mockResolvedValue([
      {
        index_name: "idx_t1_email",
        column_names: ["email"],
        is_unique: false,
        is_primary: false,
      },
    ]);

    mockGetCurrentConnector.mockImplementation((sid?: string) => (sid === "right" ? right : left));

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler(
      {
        right_source: "right",
        schema: "public",
        object_types: ["index"],
      },
      null
    );
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.index_diffs.some((d: any) => d.change === "index_only_in_right" && d.name === "idx_t1_email")).toBe(
      true
    );
  });

  it("sets truncated and warning when table lists exceed max_tables", async () => {
    mockGetAvailableSourceIds.mockReturnValue(["left", "right"]);

    const left = createMockConnector();
    const right = createMockConnector();

    vi.mocked(left.getSchemas).mockResolvedValue(["public"]);
    vi.mocked(right.getSchemas).mockResolvedValue(["public"]);

    vi.mocked(left.getTables).mockResolvedValue(["a", "b", "c", "d", "e"]);
    vi.mocked(right.getTables).mockResolvedValue(["a", "b", "c", "d", "e"]);

    mockGetCurrentConnector.mockImplementation((sid?: string) => (sid === "right" ? right : left));

    const handler = createSchemaDiffToolHandler("left");
    const result = await handler(
      {
        right_source: "right",
        schema: "public",
        object_types: ["table"],
        max_tables: 2,
      },
      null
    );
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.warnings.some((w: string) => w.includes("max_tables"))).toBe(true);
  });
});
