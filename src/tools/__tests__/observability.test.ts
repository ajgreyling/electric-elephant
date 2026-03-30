import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createExtensionsStatusToolHandler,
  createReplicationStatusToolHandler,
  createTableHealthToolHandler
} from "../observability.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { Connector, ConnectorType } from "../../connectors/interface.js";

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

describe("observability tools", () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  beforeEach(() => {
    mockConnector = createMockConnector("postgres");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("replication_status returns partial results with warnings when stats views fail", async () => {
    vi.mocked(mockConnector.executeSQL).mockImplementation(async (sql: string) => {
      if (sql.includes("pg_is_in_recovery")) {
        return {
          rows: [{ is_replica: false, server_version: "16.1", server_version_num: "160001" }],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_stat_replication")) {
        throw new Error("permission denied for view pg_stat_replication");
      }
      if (sql.includes("pg_last_wal_receive_lsn")) {
        return {
          rows: [{ last_wal_receive_lsn: null, last_wal_replay_lsn: null, last_xact_replay_timestamp: null }],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_replication_slots")) {
        throw new Error("relation pg_replication_slots does not exist");
      }
      return { rows: [], rowCount: 0 };
    });

    const handler = createReplicationStatusToolHandler("test_source");
    const result = await handler({ include_replication_slots: true }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.streaming_clients_available).toBe(false);
    expect(parsed.data.replication_slots_available).toBe(false);
    expect(parsed.data.warnings.length).toBeGreaterThan(0);
  });

  it("table_health falls back to information_schema when pg_stat_user_tables is unavailable", async () => {
    vi.mocked(mockConnector.executeSQL).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_stat_user_tables")) {
        throw new Error("permission denied for view pg_stat_user_tables");
      }
      if (sql.includes("FROM information_schema.tables")) {
        return {
          rows: [{ schema_name: "public", table_name: "users" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const handler = createTableHealthToolHandler("test_source");
    const result = await handler({ schema: "public", limit: 10 }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.stats_available).toBe(false);
    expect(parsed.data.tables).toHaveLength(1);
    expect(parsed.data.tables[0].table_name).toBe("users");
    expect(parsed.data.tables[0].estimated_dead_rows).toBeNull();
    expect(parsed.data.warnings.length).toBeGreaterThan(0);
  });

  it("extensions_status reports pg_stat_statements inactive when info view is unavailable", async () => {
    vi.mocked(mockConnector.executeSQL).mockImplementation(async (sql: string) => {
      if (sql.includes("AS installed")) {
        return { rows: [{ installed: true }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_extension")) {
        return {
          rows: [{ name: "pg_stat_statements", version: "1.10", relocatable: true }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM pg_available_extensions")) {
        return {
          rows: [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM pg_stat_statements_info")) {
        throw new Error("relation pg_stat_statements_info does not exist");
      }
      if (sql.includes("shared_preload_libraries")) {
        return { rows: [{ shared_preload_libraries: "" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const handler = createExtensionsStatusToolHandler("test_source");
    const result = await handler({ include_available: true }, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.pg_stat_statements.installed).toBe(true);
    expect(parsed.data.pg_stat_statements.info_view_available).toBe(false);
    expect(parsed.data.warnings.length).toBeGreaterThan(0);
  });
});
