import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplainPlanToolHandler } from "../explain-plan.js";
import { ConnectorManager } from "../../connectors/manager.js";
import { getToolRegistry } from "../registry.js";
import type { Connector, ConnectorType, SQLResult } from "../../connectors/interface.js";

vi.mock("../../connectors/manager.js");
vi.mock("../registry.js");

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

describe("explain_plan tool", () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  beforeEach(() => {
    mockConnector = createMockConnector("postgres");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    vi.mocked(mockConnector.getSchemas).mockResolvedValue(["public"]);
    mockGetToolRegistry.mockReturnValue({
      getBuiltinToolConfig: vi.fn().mockReturnValue({}),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds EXPLAIN JSON for a read-only query", async () => {
    const plan = [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "users" } }];
    const mockResult: SQLResult = { rows: [{ "QUERY PLAN": plan }], rowCount: 1 };
    vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

    const handler = createExplainPlanToolHandler("pg_source");
    const result = await handler({ schema: "public", sql: "SELECT * FROM users" }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.plan).toEqual(plan[0]);
    expect(mockConnector.executeSQL).toHaveBeenCalledWith(
      expect.stringContaining("EXPLAIN (FORMAT JSON"),
      { readonly: true, maxRows: 1, targetSchema: "public" }
    );
  });

  it("rejects non-read-only SQL", async () => {
    const handler = createExplainPlanToolHandler();
    const result = await handler({ schema: "public", sql: "UPDATE users SET name = 'x'" }, null);
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe("READONLY_VIOLATION");
    expect(mockConnector.executeSQL).not.toHaveBeenCalled();
  });

  it("rejects multiple statements", async () => {
    const handler = createExplainPlanToolHandler();
    const result = await handler({ schema: "public", sql: "SELECT 1; SELECT 2;" }, null);
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe("INVALID_SQL_INPUT");
  });

});
