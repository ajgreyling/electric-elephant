import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema } from "../tools/execute-sql.js";
import { diagnoseLocksSchema } from "../tools/diagnose-locks.js";
import { explainPlanSchema } from "../tools/explain-plan.js";
import {
  extensionsStatusSchema,
  replicationStatusSchema,
  tableHealthSchema
} from "../tools/observability.js";
import { getToolRegistry } from "../tools/registry.js";
import {
  BUILTIN_TOOL_DIAGNOSE_LOCKS,
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_EXPLAIN_PLAN,
  BUILTIN_TOOL_EXTENSIONS_STATUS,
  BUILTIN_TOOL_REPLICATION_STATUS,
  BUILTIN_TOOL_SEARCH_OBJECTS,
  BUILTIN_TOOL_TABLE_HEALTH
} from "../tools/builtin-tools.js";
import type { ParameterConfig, ToolConfig } from "../types/config.js";

/**
 * Tool parameter definition for API responses
 */
export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Tool metadata for API responses
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  statement?: string;
  readonly?: boolean;
  max_rows?: number;
  /** When false or omitted, execute_sql uses PII/clinical column heuristics (fail-closed). */
  allow_access_to_pii_data?: boolean;
}

/**
 * Tool metadata with Zod schema (used internally for registration)
 */
export interface ToolMetadata {
  name: string;
  description: string;
  schema: Record<string, z.ZodType<any>>;
  annotations: ToolAnnotations;
}

/**
 * Convert a Zod schema object to simplified parameter list
 * @param schema - Zod schema object (e.g., { sql: z.string().describe("...") })
 * @returns Array of tool parameters
 */
export function zodToParameters(schema: Record<string, z.ZodType<any>>): ToolParameter[] {
  const parameters: ToolParameter[] = [];

  for (const [key, zodType] of Object.entries(schema)) {
    // Extract description from Zod schema
    const description = zodType.description || "";

    // Determine if required (Zod types are required by default unless optional)
    const required = !(zodType instanceof z.ZodOptional);

    // Determine type from Zod type
    let type = "string"; // default
    if (zodType instanceof z.ZodString) {
      type = "string";
    } else if (zodType instanceof z.ZodNumber) {
      type = "number";
    } else if (zodType instanceof z.ZodBoolean) {
      type = "boolean";
    } else if (zodType instanceof z.ZodArray) {
      type = "array";
    } else if (zodType instanceof z.ZodObject) {
      type = "object";
    }

    parameters.push({
      name: key,
      type,
      required,
      description,
    });
  }

  return parameters;
}

/**
 * Get execute_sql tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExecuteSqlMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;

  // Get tool configuration from registry to extract execute_sql options
  const registry = getToolRegistry();
  const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, sourceId);
  const executeOptions = {
    readonly: toolConfig?.readonly,
    maxRows: toolConfig?.max_rows,
    allowPii: toolConfig?.allow_access_to_pii_data,
  };

  // Determine tool name based on single vs multi-source configuration
  const toolName = isSingleSource ? "execute_sql" : `execute_sql_${normalizeSourceId(sourceId)}`;

  // Determine title (human-readable display name)
  const title = isSingleSource
    ? `Execute SQL (${dbType})`
    : `Execute SQL on ${sourceId} (${dbType})`;

  // Determine description with more context
  const readonlyNote = executeOptions.readonly ? " [READ-ONLY MODE]" : "";
  const maxRowsNote = executeOptions.maxRows ? ` (limited to ${executeOptions.maxRows} rows)` : "";
  const piiNote =
    executeOptions.allowPii === true
      ? " [PII/clinical column guard off]"
      : " [PII/clinical column guard on]";
  const description = isSingleSource
    ? `Execute SQL queries on the ${dbType} database${readonlyNote}${maxRowsNote}${piiNote}`
    : `Execute SQL queries on the '${sourceId}' ${dbType} database${readonlyNote}${maxRowsNote}${piiNote}`;

  // Build annotations object with all standard MCP hints
  const isReadonly = executeOptions.readonly === true;
  const annotations = {
    title,
    readOnlyHint: isReadonly,
    destructiveHint: !isReadonly, // Can be destructive if not readonly
    // In readonly mode, queries are more predictable (though still not strictly idempotent due to data changes)
    // In write mode, queries are definitely not idempotent
    idempotentHint: false,
    // Database operations are always against internal/closed systems, not open-world
    openWorldHint: false,
  };

  return {
    name: toolName,
    description,
    schema: executeSqlSchema,
    annotations,
  };
}

/**
 * Get search_objects tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool name, description, and annotations
 */
export function getSearchObjectsMetadata(sourceId: string): { name: string; description: string; title: string } {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;

  const toolName = isSingleSource ? "search_objects" : `search_objects_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Search Database Objects (${dbType})`
    : `Search Database Objects on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? `Search and list database objects (schemas, tables, columns, procedures, functions, indexes) on the ${dbType} database`
    : `Search and list database objects (schemas, tables, columns, procedures, functions, indexes) on the '${sourceId}' ${dbType} database`;

  return {
    name: toolName,
    description,
    title,
  };
}

export function getDiagnoseLocksMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;
  const toolName = isSingleSource ? "diagnose_locks" : `diagnose_locks_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Diagnose Locks (${dbType})`
    : `Diagnose Locks on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? "Diagnose PostgreSQL lock contention, blockers, and waiting sessions"
    : `Diagnose PostgreSQL lock contention, blockers, and waiting sessions on '${sourceId}'`;

  return {
    name: toolName,
    description,
    schema: diagnoseLocksSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function getExplainPlanMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;
  const toolName = isSingleSource ? "explain_plan" : `explain_plan_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Explain Plan (${dbType})`
    : `Explain Plan on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? "Generate a structured PostgreSQL EXPLAIN plan for a single read-only query"
    : `Generate a structured PostgreSQL EXPLAIN plan for a single read-only query on '${sourceId}'`;

  return {
    name: toolName,
    description,
    schema: explainPlanSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function getReplicationStatusMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;
  const toolName = isSingleSource
    ? "replication_status"
    : `replication_status_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Replication Status (${dbType})`
    : `Replication Status on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? "Inspect PostgreSQL replication state, streaming clients, and slot health"
    : `Inspect PostgreSQL replication state, streaming clients, and slot health on '${sourceId}'`;

  return {
    name: toolName,
    description,
    schema: replicationStatusSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function getTableHealthMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;
  const toolName = isSingleSource ? "table_health" : `table_health_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Table Health (${dbType})`
    : `Table Health on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? "Report PostgreSQL table bloat indicators, dead tuples, and vacuum/analyze recency"
    : `Report PostgreSQL table bloat indicators, dead tuples, and vacuum/analyze recency on '${sourceId}'`;

  return {
    name: toolName,
    description,
    schema: tableHealthSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function getExtensionsStatusMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;
  const toolName = isSingleSource
    ? "extensions_status"
    : `extensions_status_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Extensions Status (${dbType})`
    : `Extensions Status on ${sourceId} (${dbType})`;
  const description = isSingleSource
    ? "Show PostgreSQL extension installation/availability and pg_stat_statements readiness"
    : `Show PostgreSQL extension installation/availability and pg_stat_statements readiness on '${sourceId}'`;

  return {
    name: toolName,
    description,
    schema: extensionsStatusSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

/**
 * Convert custom tool parameter configs to Tool parameter format
 * @param params - Parameter configurations from custom tool
 * @returns Array of tool parameters
 */
function customParamsToToolParams(params: ParameterConfig[] | undefined): ToolParameter[] {
  if (!params || params.length === 0) {
    return [];
  }

  return params.map((param) => ({
    name: param.name,
    type: param.type,
    required: param.required !== false && param.default === undefined,
    description: param.description,
  }));
}

/**
 * Build execute_sql tool metadata for API response
 */
function buildExecuteSqlTool(sourceId: string, toolConfig?: ToolConfig): Tool {
  const executeSqlMetadata = getExecuteSqlMetadata(sourceId);
  const executeSqlParameters = zodToParameters(executeSqlMetadata.schema);

  // Extract readonly and max_rows from toolConfig
  // ToolConfig is a union type, but ExecuteSqlToolConfig and CustomToolConfig both have these fields
  const readonly = toolConfig && 'readonly' in toolConfig ? toolConfig.readonly : undefined;
  const max_rows = toolConfig && 'max_rows' in toolConfig ? toolConfig.max_rows : undefined;
  const allow_access_to_pii_data =
    toolConfig && 'allow_access_to_pii_data' in toolConfig
      ? toolConfig.allow_access_to_pii_data
      : undefined;

  return {
    name: executeSqlMetadata.name,
    description: executeSqlMetadata.description,
    parameters: executeSqlParameters,
    readonly,
    max_rows,
    allow_access_to_pii_data,
  };
}

/**
 * Build search_objects tool metadata for API response
 */
function buildSearchObjectsTool(sourceId: string): Tool {
  const searchMetadata = getSearchObjectsMetadata(sourceId);

  return {
    name: searchMetadata.name,
    description: searchMetadata.description,
    parameters: [
      {
        name: "object_type",
        type: "string",
        required: true,
        description: "Object type to search",
      },
      {
        name: "pattern",
        type: "string",
        required: false,
        description: "LIKE pattern (% = any chars, _ = one char). Default: %",
      },
      {
        name: "schema",
        type: "string",
        required: false,
        description: "Filter to schema",
      },
      {
        name: "table",
        type: "string",
        required: false,
        description: "Filter to table (requires schema; column/index only)",
      },
      {
        name: "detail_level",
        type: "string",
        required: false,
        description: "Detail: names (minimal), summary (metadata), full (all)",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Max results (default: 100, max: 1000)",
      },
    ],
    readonly: true, // search_objects is always readonly
  };
}

function buildDiagnoseLocksTool(sourceId: string): Tool {
  const metadata = getDiagnoseLocksMetadata(sourceId);
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: zodToParameters(metadata.schema),
    readonly: true,
  };
}

function buildExplainPlanTool(sourceId: string): Tool {
  const metadata = getExplainPlanMetadata(sourceId);
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: zodToParameters(metadata.schema),
    readonly: true,
  };
}

function buildReplicationStatusTool(sourceId: string): Tool {
  const metadata = getReplicationStatusMetadata(sourceId);
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: zodToParameters(metadata.schema),
    readonly: true,
  };
}

function buildTableHealthTool(sourceId: string): Tool {
  const metadata = getTableHealthMetadata(sourceId);
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: zodToParameters(metadata.schema),
    readonly: true,
  };
}

function buildExtensionsStatusTool(sourceId: string): Tool {
  const metadata = getExtensionsStatusMetadata(sourceId);
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: zodToParameters(metadata.schema),
    readonly: true,
  };
}

/**
 * Build custom tool metadata for API response
 */
function buildCustomTool(toolConfig: ToolConfig): Tool {
  return {
    name: toolConfig.name,
    description: toolConfig.description!,
    parameters: customParamsToToolParams(toolConfig.parameters),
    statement: toolConfig.statement,
    readonly: toolConfig.readonly,
    max_rows: toolConfig.max_rows,
  };
}

/**
 * Get tools for a specific source (API response format)
 * Only includes tools that are actually enabled in the ToolRegistry
 * @param sourceId - The source ID to get tools for
 * @returns Array of enabled tools with simplified parameters
 */
export function getToolsForSource(sourceId: string): Tool[] {
  // Get enabled tools from registry
  const registry = getToolRegistry();
  const enabledToolConfigs = registry.getEnabledToolConfigs(sourceId);

  // Uniform iteration: map each enabled tool config to its API representation
  return enabledToolConfigs.map((toolConfig) => {
    // Dispatch based on tool name
    if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
      return buildExecuteSqlTool(sourceId, toolConfig);
    } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
      return buildSearchObjectsTool(sourceId);
    } else if (toolConfig.name === BUILTIN_TOOL_DIAGNOSE_LOCKS) {
      return buildDiagnoseLocksTool(sourceId);
    } else if (toolConfig.name === BUILTIN_TOOL_EXPLAIN_PLAN) {
      return buildExplainPlanTool(sourceId);
    } else if (toolConfig.name === BUILTIN_TOOL_REPLICATION_STATUS) {
      return buildReplicationStatusTool(sourceId);
    } else if (toolConfig.name === BUILTIN_TOOL_TABLE_HEALTH) {
      return buildTableHealthTool(sourceId);
    } else if (toolConfig.name === BUILTIN_TOOL_EXTENSIONS_STATUS) {
      return buildExtensionsStatusTool(sourceId);
    } else {
      // Custom tool
      return buildCustomTool(toolConfig);
    }
  });
}
