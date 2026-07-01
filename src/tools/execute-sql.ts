import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { isReadOnlySQL, allowedKeywords } from "../utils/allowed-keywords.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";
import { splitSQLStatements } from "../utils/sql-parser.js";
import { validateSqlPiiAccessGuard } from "../utils/pii-sql-guard.js";
import {
  DEFAULT_CLINICAL_STANDARDS,
  type ClinicalStandard,
} from "../utils/pii-heuristics.js";
import { validateSqlSchemaScope } from "../utils/sql-schema-scope.js";
import { schemaExists, validateTargetSchemaArg } from "../utils/target-schema.js";
import type { ExecuteSqlToolConfig } from "../types/config.js";

// Schema for execute_sql tool
export const executeSqlSchema = {
  schema: z
    .string()
    .min(1)
    .describe(
      "Target schema for this query (required). SQL must stay within this schema; cross-schema and system-catalog (information_schema, pg_catalog) references are rejected."
    ),
  sql: z
    .string()
    .describe(
      "SQL to execute (multiple statements separated by ;). Health/clinical data (HL7v2, FHIR, LOINC, SNOMED, medical fields), personal identifiers (names, email, national IDs, DOB, address), and wildcard projections (SELECT *, table.*) are always blocked and cannot be returned; only the user's mobile/phone number may be permitted via allow_access_to_pii_data. List explicit, non-sensitive columns."
    ),
};

/**
 * Check if all SQL statements in a multi-statement query are read-only
 * @param sql The SQL string (possibly containing multiple statements)
 * @param connectorType The database type to check against
 * @returns True if all statements are read-only
 */
function areAllStatementsReadOnly(sql: string): boolean {
  const statements = splitSQLStatements(sql);
  return statements.every((statement) => isReadOnlySQL(statement));
}

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql, schema } = args as { sql: string; schema: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const actualSourceId = connector.getId();

      // Get tool-specific configuration (tool is already registered, so it's enabled)
      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(
        BUILTIN_TOOL_EXECUTE_SQL,
        actualSourceId
      ) as ExecuteSqlToolConfig | undefined;

      const allowlistResult = validateTargetSchemaArg(schema, toolConfig?.allowed_schemas);
      if (!allowlistResult.ok) {
        errorMessage = allowlistResult.message;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: allowlistResult.reason,
        });
      }

      if (!(await schemaExists(connector, schema))) {
        errorMessage = `Schema '${schema}' does not exist`;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
      }

      const scopeResult = validateSqlSchemaScope(sql, schema);
      if (!scopeResult.ok) {
        errorMessage = scopeResult.message;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: scopeResult.reason,
          reference: scopeResult.reference,
        });
      }

      // Check if SQL is allowed based on readonly mode (per-tool)
      const isReadonly = toolConfig?.readonly === true;
      if (isReadonly && !areAllStatementsReadOnly(sql)) {
        errorMessage = `Read-only mode is enabled. Only the following SQL operations are allowed: ${allowedKeywords.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      const allowPiiAccess = toolConfig?.allow_access_to_pii_data === true;
      const configuredStandards =
        toolConfig?.clinical_standards;
      const enabledStandards =
        configuredStandards && configuredStandards.length > 0
          ? configuredStandards
          : DEFAULT_CLINICAL_STANDARDS;
      const piiGuard = validateSqlPiiAccessGuard(sql, allowPiiAccess, enabledStandards);
      if (!piiGuard.ok) {
        errorMessage = piiGuard.message;
        success = false;
        return createToolErrorResponse(
          piiGuard.message,
          "PII_ACCESS_VIOLATION",
          { reason: piiGuard.reason, matches: piiGuard.matches }
        );
      }

      // Execute the SQL (single or multiple statements) if validation passed
      const executeOptions = {
        readonly: toolConfig?.readonly,
        maxRows: toolConfig?.max_rows,
        targetSchema: schema,
      };
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data
      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: effectiveSourceId,
        schema,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "execute_sql" : `execute_sql_${effectiveSourceId}`,
          sql,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
