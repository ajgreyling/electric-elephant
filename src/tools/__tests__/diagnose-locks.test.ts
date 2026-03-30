import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDiagnoseLocksToolHandler } from "../diagnose-locks.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { Connector, ConnectorType, SQLResult } from "../../connectors/interface.js";

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

describe("diagnose_locks tool", () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  beforeEach(() => {
    mockConnector = createMockConnector("postgres");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns blocking lock chains for postgres", async () => {
    const mockRows = [
      {
        waiting_pid: 101,
        blocking_pid: 202,
        waiting_state: "active",
        blocking_state: "active",
        waiting_seconds: 33,
      },
    ];
    const mockResult: SQLResult = { rows: mockRows, rowCount: 1 };
    vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

    const handler = createDiagnoseLocksToolHandler("pg_source");
    const result = await handler({ min_wait_seconds: 10, limit: 5 }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.locks).toEqual(mockRows);
    expect(mockConnector.executeSQL).toHaveBeenCalledWith(
      expect.stringContaining("pg_stat_activity"),
      { readonly: true, maxRows: 5 },
      [10, 5]
    );
  });

  it("filters idle sessions by default", async () => {
    const mockResult: SQLResult = {
      rows: [
        { waiting_pid: 1, waiting_state: "active", blocking_state: "active" },
        { waiting_pid: 2, waiting_state: "idle in transaction", blocking_state: "active" },
      ],
      rowCount: 2,
    };
    vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

    const handler = createDiagnoseLocksToolHandler();
    const result = await handler({}, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.locks).toEqual([{ waiting_pid: 1, waiting_state: "active", blocking_state: "active" }]);
  });

});
