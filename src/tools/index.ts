import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { createDiagnoseLocksToolHandler, diagnoseLocksSchema } from "./diagnose-locks.js";
import { createExplainPlanToolHandler, explainPlanSchema } from "./explain-plan.js";
import {
  createExtensionsStatusToolHandler,
  createReplicationStatusToolHandler,
  createTableHealthToolHandler,
  extensionsStatusSchema,
  replicationStatusSchema,
  tableHealthSchema
} from "./observability.js";
import { ConnectorManager } from "../connectors/manager.js";
import {
  getDiagnoseLocksMetadata,
  getExtensionsStatusMetadata,
  getExecuteSqlMetadata,
  getExplainPlanMetadata,
  getQueryInsightsMetadata,
  getReplicationStatusMetadata,
  getSchemaDiffMetadata,
  getSearchObjectsMetadata,
  getTableHealthMetadata
} from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import { createQueryInsightsToolHandler, queryInsightsSchema } from "./query-insights.js";
import { createSchemaDiffToolHandler, schemaDiffSchema } from "./schema-diff.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import {
  BUILTIN_TOOL_DIAGNOSE_LOCKS,
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_EXTENSIONS_STATUS,
  BUILTIN_TOOL_EXPLAIN_PLAN,
  BUILTIN_TOOL_QUERY_INSIGHTS,
  BUILTIN_TOOL_REPLICATION_STATUS,
  BUILTIN_TOOL_SCHEMA_DIFF,
  BUILTIN_TOOL_TABLE_HEALTH,
  BUILTIN_TOOL_SEARCH_OBJECTS
} from "./builtin-tools.js";

/**
 * Register all tool handlers with the MCP server
 * Iterates through all enabled tools from the registry and registers them
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  const registry = getToolRegistry();

  // Register all enabled tools (both built-in and custom) for each source
  for (const sourceId of sourceIds) {
    const enabledTools = registry.getEnabledToolConfigs(sourceId);

    for (const toolConfig of enabledTools) {
      // Register based on tool name (built-in vs custom)
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_DIAGNOSE_LOCKS) {
        registerDiagnoseLocksTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_EXPLAIN_PLAN) {
        registerExplainPlanTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_REPLICATION_STATUS) {
        registerReplicationStatusTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_TABLE_HEALTH) {
        registerTableHealthTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_EXTENSIONS_STATUS) {
        registerExtensionsStatusTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_QUERY_INSIGHTS) {
        registerQueryInsightsTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_SCHEMA_DIFF) {
        registerSchemaDiffTool(server, sourceId);
      } else {
        // Custom tool
        registerCustomTool(server, sourceId, toolConfig);
      }
    }
  }
}

/**
 * Register execute_sql tool for a source
 */
function registerExecuteSqlTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExecuteSqlMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: metadata.schema,
      annotations: metadata.annotations,
    },
    createExecuteSqlToolHandler(sourceId)
  );
}

/**
 * Register search_objects tool for a source
 */
function registerSearchObjectsTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getSearchObjectsMetadata(sourceId);

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: searchDatabaseObjectsSchema,
      annotations: {
        title: metadata.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createSearchDatabaseObjectsToolHandler(sourceId)
  );
}

/**
 * Register diagnose_locks tool for a source
 */
function registerDiagnoseLocksTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getDiagnoseLocksMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: diagnoseLocksSchema,
      annotations: metadata.annotations,
    },
    createDiagnoseLocksToolHandler(sourceId)
  );
}

/**
 * Register explain_plan tool for a source
 */
function registerExplainPlanTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExplainPlanMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: explainPlanSchema,
      annotations: metadata.annotations,
    },
    createExplainPlanToolHandler(sourceId)
  );
}

/**
 * Register replication_status tool for a source
 */
function registerReplicationStatusTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getReplicationStatusMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: replicationStatusSchema,
      annotations: metadata.annotations,
    },
    createReplicationStatusToolHandler(sourceId)
  );
}

/**
 * Register table_health tool for a source
 */
function registerTableHealthTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getTableHealthMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: tableHealthSchema,
      annotations: metadata.annotations,
    },
    createTableHealthToolHandler(sourceId)
  );
}

/**
 * Register extensions_status tool for a source
 */
function registerQueryInsightsTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getQueryInsightsMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: queryInsightsSchema,
      annotations: metadata.annotations,
    },
    createQueryInsightsToolHandler(sourceId)
  );
}

function registerSchemaDiffTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getSchemaDiffMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: schemaDiffSchema,
      annotations: metadata.annotations,
    },
    createSchemaDiffToolHandler(sourceId)
  );
}

function registerExtensionsStatusTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExtensionsStatusMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: extensionsStatusSchema,
      annotations: metadata.annotations,
    },
    createExtensionsStatusToolHandler(sourceId)
  );
}

/**
 * Register a custom tool
 */
function registerCustomTool(
  server: McpServer,
  sourceId: string,
  toolConfig: ToolConfig
): void {
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;

  const isReadOnly = isReadOnlySQL(toolConfig.statement!);
  const zodSchema = buildZodSchemaFromParameters(toolConfig.parameters);

  server.registerTool(
    toolConfig.name,
    {
      description: toolConfig.description,
      inputSchema: zodSchema,
      annotations: {
        title: `${toolConfig.name} (${dbType})`,
        readOnlyHint: isReadOnly,
        destructiveHint: !isReadOnly,
        idempotentHint: isReadOnly,
        openWorldHint: false,
      },
    },
    createCustomToolHandler(toolConfig)
  );
}
