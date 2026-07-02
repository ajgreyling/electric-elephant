import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";
import { redactSqlLiterals } from "../utils/sql-parser.js";

export const queryInsightsSchema = {
  sort_by: z
    .enum(["total_time", "mean_time", "calls", "rows"])
    .default("total_time")
    .describe(
      "Sort key: total_time (total elapsed ms), mean_time (per-call avg ms), calls, rows (sum returned)"
    ),
  query_like: z
    .string()
    .optional()
    .describe("Optional SQL LIKE pattern matched against query text (e.g. %FROM orders%)"),
  min_calls: z
    .number()
    .int()
    .min(1)
    .max(1_000_000_000)
    .default(1)
    .describe("Minimum number of executions to include a statement"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Max statements to return (default 20, max 100)"),
};

/** pg_stat_statements columns differ before PG13 (total_time vs total_exec_time). */
const QUERY_INSIGHTS_SQL = `
WITH ver AS (
  SELECT COALESCE(
    NULLIF(current_setting('server_version_num', true), '')::int,
    130000
  ) AS version_num
),
stats AS (
  SELECT
    s.queryid::text AS queryid,
    LEFT(s.query, 4000) AS query,
    s.calls::bigint AS calls,
    CASE
      WHEN (SELECT version_num FROM ver) >= 130000 THEN s.total_exec_time::double precision
      ELSE s.total_time::double precision
    END AS total_ms,
    CASE
      WHEN (SELECT version_num FROM ver) >= 130000 THEN s.mean_exec_time::double precision
      ELSE s.mean_time::double precision
    END AS mean_ms,
    s.rows::bigint AS rows,
    s.shared_blks_hit::bigint AS shared_blks_hit,
    s.shared_blks_read::bigint AS shared_blks_read,
    s.local_blks_hit::bigint AS local_blks_hit,
    s.local_blks_read::bigint AS local_blks_read
  FROM pg_stat_statements s
  WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND s.calls >= $1
    AND ($2::text IS NULL OR s.query ILIKE $2)
)
SELECT *
FROM stats
ORDER BY
  CASE $3::text
    WHEN 'total_time' THEN total_ms
    WHEN 'mean_time' THEN mean_ms
    WHEN 'calls' THEN calls::double precision
    WHEN 'rows' THEN rows::double precision
    ELSE total_ms
  END DESC NULLS LAST
LIMIT $4
`;

const PG_STAT_STATEMENTS_INSTALLED_SQL = `
SELECT EXISTS (
  SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
) AS installed
`;

const STATS_RESET_SQL = `
SELECT stats_reset
FROM pg_stat_statements_info
LIMIT 1
`;

export function createQueryInsightsToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      sort_by = "total_time",
      query_like,
      min_calls = 1,
      limit = 20,
    } = args as {
      sort_by?: "total_time" | "mean_time" | "calls" | "rows";
      query_like?: string;
      min_calls?: number;
      limit?: number;
    };

    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      if (connector.id !== "postgres") {
        success = false;
        errorMessage = "query_insights is only available for PostgreSQL sources";
        return createToolErrorResponse(errorMessage, "UNSUPPORTED_DATABASE");
      }

      const installedResult = await connector.executeSQL(
        PG_STAT_STATEMENTS_INSTALLED_SQL,
        { readonly: true, maxRows: 1 }
      );
      const installed = installedResult.rows[0]?.installed === true;

      if (!installed) {
        return createToolSuccessResponse({
          source_id: effectiveSourceId,
          pg_stat_statements_available: false,
          message:
            "pg_stat_statements extension is not installed. Install with CREATE EXTENSION pg_stat_statements (requires superuser or appropriate privileges).",
          stats_reset: null,
          statements: [],
        });
      }

      let statsReset: string | null = null;
      try {
        const resetResult = await connector.executeSQL(STATS_RESET_SQL, { readonly: true, maxRows: 1 });
        statsReset = resetResult.rows[0]?.stats_reset ?? null;
      } catch {
        // View may be unavailable if extension not fully active
      }

      const patternParam = query_like != null && query_like !== "" ? query_like : null;

      let result;
      try {
        result = await connector.executeSQL(
          QUERY_INSIGHTS_SQL,
          { readonly: true, maxRows: limit },
          [min_calls, patternParam, sort_by, limit]
        );
      } catch (err) {
        const msg = (err as Error).message;
        // Graceful fallback when view exists but is not readable or columns mismatch
        return createToolSuccessResponse({
          source_id: effectiveSourceId,
          pg_stat_statements_available: false,
          message: `Could not read pg_stat_statements: ${msg}`,
          stats_reset: statsReset,
          statements: [],
          warnings: [msg],
        });
      }

      const statements = (result.rows || []).map((row: Record<string, unknown>) => ({
        queryid: row.queryid,
        // Redact any literal values that survive pg_stat_statements normalization,
        // so personal data embedded in query text is not returned.
        query: typeof row.query === "string" ? redactSqlLiterals(row.query) : row.query,
        calls: row.calls,
        total_ms: row.total_ms,
        mean_ms: row.mean_ms,
        rows: row.rows,
        shared_blks_hit: row.shared_blks_hit,
        shared_blks_read: row.shared_blks_read,
        local_blks_hit: row.local_blks_hit,
        local_blks_read: row.local_blks_read,
        recommended_next_step:
          "Use explain_plan with a single representative SELECT (or read-only) statement derived from this fingerprint.",
      }));

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        pg_stat_statements_available: true,
        stats_reset: statsReset,
        sort_by,
        min_calls,
        query_like: patternParam,
        count: statements.length,
        statements,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "QUERY_INSIGHTS_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName:
            effectiveSourceId === "default" ? "query_insights" : `query_insights_${effectiveSourceId}`,
          sql: `query_insights(sort_by=${sort_by}, min_calls=${min_calls}, limit=${limit})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
