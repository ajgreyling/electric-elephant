/**
 * Built-in tool constants
 * Central location for built-in tool names used throughout the codebase
 */

export const BUILTIN_TOOL_EXECUTE_SQL = "execute_sql";
export const BUILTIN_TOOL_SEARCH_OBJECTS = "search_objects";
export const BUILTIN_TOOL_DIAGNOSE_LOCKS = "diagnose_locks";
export const BUILTIN_TOOL_EXPLAIN_PLAN = "explain_plan";
export const BUILTIN_TOOL_REPLICATION_STATUS = "replication_status";
export const BUILTIN_TOOL_TABLE_HEALTH = "table_health";
export const BUILTIN_TOOL_EXTENSIONS_STATUS = "extensions_status";

export const BUILTIN_TOOLS = [
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
  BUILTIN_TOOL_DIAGNOSE_LOCKS,
  BUILTIN_TOOL_EXPLAIN_PLAN,
  BUILTIN_TOOL_REPLICATION_STATUS,
  BUILTIN_TOOL_TABLE_HEALTH,
  BUILTIN_TOOL_EXTENSIONS_STATUS,
] as const;
