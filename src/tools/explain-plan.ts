import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { splitSQLStatements } from "../utils/sql-parser.js";
import { validateSqlSchemaScope } from "../utils/sql-schema-scope.js";
import { schemaExists, validateTargetSchemaArg } from "../utils/target-schema.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXPLAIN_PLAN } from "./builtin-tools.js";
import type { ExplainPlanToolConfig } from "../types/config.js";

export const explainPlanSchema = {
  schema: z.string().min(1).describe("Target schema for this query (required)"),
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
      schema,
      sql,
      analyze = false,
      verbose = false,
      buffers = true,
      settings = true,
      timing = false,
      summary = true,
    } = args as {
      schema: string;
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

      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(
        BUILTIN_TOOL_EXPLAIN_PLAN,
        connector.getId()
      ) as ExplainPlanToolConfig | undefined;

      const allowlistResult = validateTargetSchemaArg(schema, toolConfig?.allowed_schemas);
      if (!allowlistResult.ok) {
        success = false;
        errorMessage = allowlistResult.message;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: allowlistResult.reason,
        });
      }

      if (!(await schemaExists(connector, schema))) {
        success = false;
        errorMessage = `Schema '${schema}' does not exist`;
        return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
      }

      const normalizedSql = normalizeExplainInput(sql);
      const statements = splitSQLStatements(normalizedSql);
      if (statements.length !== 1) {
        success = false;
        errorMessage = "explain_plan accepts exactly one SQL statement";
        return createToolErrorResponse(errorMessage, "INVALID_SQL_INPUT");
      }

      const scopeResult = validateSqlSchemaScope(statements[0], schema);
      if (!scopeResult.ok) {
        success = false;
        errorMessage = scopeResult.message;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: scopeResult.reason,
          reference: scopeResult.reference,
        });
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
      const result = await connector.executeSQL(explainSql, {
        readonly: true,
        maxRows: 1,
        targetSchema: schema,
      });
      const firstRow = result.rows[0] || {};
      const rawPlan = firstRow["QUERY PLAN"] ?? firstRow.query_plan ?? firstRow.queryPlan ?? firstRow;
      const plan = Array.isArray(rawPlan) && rawPlan.length === 1 ? rawPlan[0] : rawPlan;

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        schema,
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
