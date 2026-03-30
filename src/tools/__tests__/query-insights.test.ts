import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQueryInsightsToolHandler } from "../query-insights.js";
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

describe("query_insights tool", () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockEnsureConnected = vi.mocked(ConnectorManager.ensureConnected);

  beforeEach(() => {
    mockConnector = createMockConnector("postgres");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    mockEnsureConnected.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns pg_stat_statements unavailable when extension not installed", async () => {
    vi.mocked(mockConnector.executeSQL).mockResolvedValueOnce({
      rows: [{ installed: false }],
      rowCount: 1,
    } as SQLResult);

    const handler = createQueryInsightsToolHandler("dev");
    const result = await handler({}, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.pg_stat_statements_available).toBe(false);
    expect(parsed.data.statements).toEqual([]);
    expect(String(parsed.data.message)).toContain("pg_stat_statements");
  });

  it("returns ranked statements when extension is installed", async () => {
    vi.mocked(mockConnector.executeSQL)
      .mockResolvedValueOnce({
        rows: [{ installed: true }],
        rowCount: 1,
      } as SQLResult)
      .mockResolvedValueOnce({
        rows: [{ stats_reset: "2024-01-01" }],
        rowCount: 1,
      } as SQLResult)
      .mockResolvedValueOnce({
        rows: [
          {
            queryid: "1",
            query: "SELECT 1",
            calls: 10n,
            total_ms: 100.5,
            mean_ms: 10.05,
            rows: 10n,
            shared_blks_hit: 100n,
            shared_blks_read: 0n,
            local_blks_hit: 0n,
            local_blks_read: 0n,
          },
        ],
        rowCount: 1,
      } as SQLResult);

    const handler = createQueryInsightsToolHandler();
    const result = await handler({ sort_by: "total_time", limit: 5, min_calls: 1 }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.pg_stat_statements_available).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.statements[0].recommended_next_step).toContain("explain_plan");
    expect(mockConnector.executeSQL).toHaveBeenCalledTimes(3);
  });

  it("rejects non-postgres connector", async () => {
    const badConnector = createMockConnector("postgres");
    (badConnector as { id: string }).id = "other";
    mockGetCurrentConnector.mockReturnValue(badConnector as any);

    const handler = createQueryInsightsToolHandler();
    const result = await handler({}, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("UNSUPPORTED_DATABASE");
  });

  it("returns soft unavailable when pg_stat_statements is unreadable after install check", async () => {
    vi.mocked(mockConnector.executeSQL)
      .mockResolvedValueOnce({
        rows: [{ installed: true }],
        rowCount: 1,
      } as SQLResult)
      .mockResolvedValueOnce({
        rows: [{ stats_reset: null }],
        rowCount: 1,
      } as SQLResult)
      .mockRejectedValueOnce(new Error("permission denied for view pg_stat_statements"));

    const handler = createQueryInsightsToolHandler("db1");
    const result = await handler({}, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.pg_stat_statements_available).toBe(false);
    expect(parsed.data.statements).toEqual([]);
    expect(String(parsed.data.message)).toContain("Could not read");
  });

  it("passes min_calls, query_like, sort_by, and limit to the stats query", async () => {
    vi.mocked(mockConnector.executeSQL)
      .mockResolvedValueOnce({ rows: [{ installed: true }], rowCount: 1 } as SQLResult)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as SQLResult)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as SQLResult);

    const handler = createQueryInsightsToolHandler();
    await handler(
      {
        sort_by: "calls",
        query_like: "%SELECT%",
        min_calls: 3,
        limit: 12,
      },
      null
    );

    const statsCall = vi.mocked(mockConnector.executeSQL).mock.calls[2];
    expect(statsCall[2]).toEqual([3, "%SELECT%", "calls", 12]);
  });
});
