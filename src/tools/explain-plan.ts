import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { splitSQLStatements } from "../utils/sql-parser.js";

export const explainPlanSchema = {
  sql: z.string().describe("A single read-only SQL statement to explain"),
  analyze: z.boolean().default(false).describe("Run EXPLAIN ANALYZE (default: false)"),
  verbose: z.boolean().default(false).describe("Include VERBOSE plan details (default: false)"),
  buffers: z.boolean().default(true).describe("Include buffer usage (default: true)"),
  settings: z.boolean().default(true).describe("Include planner settings (default: true)"),
  timing: z.boolean().default(false).describe("Collect per-node timing when analyze=true (default: false)"),
  summary: z.boolean().default(true).describe("Include planning/execution summary (default: true)"),
};

function normalizeExplainInput(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("The 'sql' parameter cannot be empty");
  }
  if (/^explain\b/i.test(trimmed)) {
    throw new Error("Pass the target query only; explain_plan adds EXPLAIN automatically");
  }
  return trimmed;
}

export function createExplainPlanToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      sql,
      analyze = false,
      verbose = false,
      buffers = true,
      settings = true,
      timing = false,
      summary = true,
    } = args as {
      sql: string;
      analyze?: boolean;
      verbose?: boolean;
      buffers?: boolean;
      settings?: boolean;
      timing?: boolean;
      summary?: boolean;
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
        errorMessage = "explain_plan is only available for PostgreSQL sources";
        return createToolErrorResponse(errorMessage, "UNSUPPORTED_DATABASE");
      }

      const normalizedSql = normalizeExplainInput(sql);
      const statements = splitSQLStatements(normalizedSql);
      if (statements.length !== 1) {
        success = false;
        errorMessage = "explain_plan accepts exactly one SQL statement";
        return createToolErrorResponse(errorMessage, "INVALID_SQL_INPUT");
      }
      if (!isReadOnlySQL(statements[0])) {
        success = false;
        errorMessage = "explain_plan only supports read-only SQL statements";
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      const explainOptions = [
        "FORMAT JSON",
        `ANALYZE ${analyze ? "TRUE" : "FALSE"}`,
        `VERBOSE ${verbose ? "TRUE" : "FALSE"}`,
        `BUFFERS ${buffers ? "TRUE" : "FALSE"}`,
        `SETTINGS ${settings ? "TRUE" : "FALSE"}`,
        `TIMING ${timing ? "TRUE" : "FALSE"}`,
        `SUMMARY ${summary ? "TRUE" : "FALSE"}`,
      ].join(", ");

      const explainSql = `EXPLAIN (${explainOptions}) ${statements[0]}`;
      const result = await connector.executeSQL(explainSql, { readonly: true, maxRows: 1 });
      const firstRow = result.rows[0] || {};
      const rawPlan = firstRow["QUERY PLAN"] ?? firstRow.query_plan ?? firstRow.queryPlan ?? firstRow;
      const plan = Array.isArray(rawPlan) && rawPlan.length === 1 ? rawPlan[0] : rawPlan;

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        query: statements[0],
        options: { analyze, verbose, buffers, settings, timing, summary, format: "json" },
        plan,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXPLAIN_PLAN_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "explain_plan" : `explain_plan_${effectiveSourceId}`,
          sql: sql || "",
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
