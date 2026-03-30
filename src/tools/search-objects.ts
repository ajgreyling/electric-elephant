import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import type { Connector } from "../connectors/interface.js";
import { quoteQualifiedIdentifier } from "../utils/identifier-quoter.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";

/**
 * Object types that can be searched
 */
export type DatabaseObjectType = "schema" | "table" | "column" | "procedure" | "function" | "index";

/**
 * Detail level for search results
 * - names: Just object names (minimal tokens)
 * - summary: Names + brief metadata (row count, column count, etc.)
 * - full: Complete structure details
 */
export type DetailLevel = "names" | "summary" | "full";

type PostgresForeignKeyDetail = {
  name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
  on_update: string;
  on_delete: string;
  deferrable: boolean;
  initially_deferred: boolean;
};

type PostgresTriggerDetail = {
  name: string;
  timing: string;
  events: string[];
  enabled: string;
  definition: string;
};

type PostgresSequenceDetail = {
  schema: string;
  name: string;
  owner_column: string | null;
};

// Schema for search_objects tool (unified search and list)
export const searchDatabaseObjectsSchema = {
  object_type: z
    .enum(["schema", "table", "column", "procedure", "function", "index"])
    .describe("Object type to search"),
  pattern: z
    .string()
    .optional()
    .default("%")
    .describe("LIKE pattern (% = any chars, _ = one char). Default: %"),
  schema: z
    .string()
    .optional()
    .describe("Filter to schema"),
  table: z
    .string()
    .optional()
    .describe("Filter to table (requires schema; column/index only)"),
  detail_level: z
    .enum(["names", "summary", "full"])
    .default("names")
    .describe("Detail: names (minimal), summary (metadata), full (all)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe("Max results (default: 100, max: 1000)"),
};

/**
 * Convert SQL LIKE pattern to JavaScript regex
 * Supports % (any chars) and _ (single char)
 */
function likePatternToRegex(pattern: string): RegExp {
  // Escape special regex characters except % and _
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Get row count estimate for a table.
 * Prefers the connector's native statistics-based method (e.g. pg_class.reltuples)
 * when available, falling back to COUNT(*) for connectors that don't implement it.
 */
async function getTableRowCount(
  connector: Connector,
  tableName: string,
  schemaName?: string
): Promise<number | null> {
  try {
    if (connector.getTableRowCount) {
      return await connector.getTableRowCount(tableName, schemaName);
    }

    // Fallback: COUNT(*) for connectors without a statistics-based implementation
    const qualifiedTable = quoteQualifiedIdentifier(tableName, schemaName);
    const countQuery = `SELECT COUNT(*) as count FROM ${qualifiedTable}`;
    const result = await connector.executeSQL(countQuery, { maxRows: 1 });

    if (result.rows && result.rows.length > 0) {
      return Number(result.rows[0].count || result.rows[0].COUNT || 0);
    }
  } catch (error) {
    // If we can't get row count, return null (not critical)
    return null;
  }
  return null;
}

/**
 * Get table comment from the connector if supported.
 */
async function getTableComment(
  connector: Connector,
  tableName: string,
  schemaName?: string
): Promise<string | null> {
  try {
    if (connector.getTableComment) {
      return await connector.getTableComment(tableName, schemaName);
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Get PostgreSQL relation kind for a table-like object.
 */
async function getPostgresRelationKind(
  connector: Connector,
  tableName: string,
  schemaName: string
): Promise<string | undefined> {
  if (connector.id !== "postgres") {
    return undefined;
  }

  try {
    const result = await connector.executeSQL(
      `
      SELECT c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relname = $2
      LIMIT 1
    `,
      { maxRows: 1 },
      [schemaName, tableName]
    );

    const relkind = result.rows?.[0]?.relkind as string | undefined;
    if (!relkind) {
      return undefined;
    }

    const kindMap: Record<string, string> = {
      r: "table",
      p: "partitioned_table",
      v: "view",
      m: "materialized_view",
      f: "foreign_table",
    };

    return kindMap[relkind] ?? relkind;
  } catch {
    return undefined;
  }
}

/**
 * Get PostgreSQL foreign key details for a relation.
 */
async function getPostgresForeignKeys(
  connector: Connector,
  tableName: string,
  schemaName: string
): Promise<PostgresForeignKeyDetail[]> {
  if (connector.id !== "postgres") {
    return [];
  }

  try {
    const result = await connector.executeSQL(
      `
      SELECT
        c.conname AS constraint_name,
        array_agg(src_col.attname ORDER BY src_pos.ord) AS source_columns,
        ref_ns.nspname AS referenced_schema,
        ref_tbl.relname AS referenced_table,
        array_agg(ref_col.attname ORDER BY src_pos.ord) AS referenced_columns,
        c.confupdtype AS update_action,
        c.confdeltype AS delete_action,
        c.condeferrable AS is_deferrable,
        c.condeferred AS is_initially_deferred
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class src_tbl ON src_tbl.oid = c.conrelid
      JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src_tbl.relnamespace
      JOIN pg_catalog.pg_class ref_tbl ON ref_tbl.oid = c.confrelid
      JOIN pg_catalog.pg_namespace ref_ns ON ref_ns.oid = ref_tbl.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS src_pos(attnum, ord) ON true
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS ref_pos(attnum, ord) ON ref_pos.ord = src_pos.ord
      JOIN pg_catalog.pg_attribute src_col ON src_col.attrelid = src_tbl.oid AND src_col.attnum = src_pos.attnum
      JOIN pg_catalog.pg_attribute ref_col ON ref_col.attrelid = ref_tbl.oid AND ref_col.attnum = ref_pos.attnum
      WHERE c.contype = 'f'
      AND src_ns.nspname = $1
      AND src_tbl.relname = $2
      GROUP BY
        c.conname,
        ref_ns.nspname,
        ref_tbl.relname,
        c.confupdtype,
        c.confdeltype,
        c.condeferrable,
        c.condeferred
      ORDER BY c.conname
    `,
      { maxRows: 1000 },
      [schemaName, tableName]
    );

    const actionMap: Record<string, string> = {
      a: "no_action",
      r: "restrict",
      c: "cascade",
      n: "set_null",
      d: "set_default",
    };

    return result.rows.map((row: any) => ({
      name: row.constraint_name,
      columns: row.source_columns || [],
      referenced_schema: row.referenced_schema,
      referenced_table: row.referenced_table,
      referenced_columns: row.referenced_columns || [],
      on_update: actionMap[row.update_action] ?? row.update_action,
      on_delete: actionMap[row.delete_action] ?? row.delete_action,
      deferrable: Boolean(row.is_deferrable),
      initially_deferred: Boolean(row.is_initially_deferred),
    }));
  } catch {
    return [];
  }
}

/**
 * Get PostgreSQL trigger details for a relation.
 */
async function getPostgresTriggers(
  connector: Connector,
  tableName: string,
  schemaName: string
): Promise<PostgresTriggerDetail[]> {
  if (connector.id !== "postgres") {
    return [];
  }

  try {
    const result = await connector.executeSQL(
      `
      SELECT
        t.tgname AS trigger_name,
        CASE
          WHEN (t.tgtype & 2) = 2 THEN 'before'
          WHEN (t.tgtype & 64) = 64 THEN 'instead_of'
          ELSE 'after'
        END AS trigger_timing,
        t.tgenabled AS trigger_enabled,
        pg_catalog.pg_get_triggerdef(t.oid, true) AS trigger_definition,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN (t.tgtype & 4) = 4 THEN 'insert' END,
          CASE WHEN (t.tgtype & 8) = 8 THEN 'delete' END,
          CASE WHEN (t.tgtype & 16) = 16 THEN 'update' END,
          CASE WHEN (t.tgtype & 32) = 32 THEN 'truncate' END
        ], NULL) AS trigger_events
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relname = $2
      AND NOT t.tgisinternal
      ORDER BY t.tgname
    `,
      { maxRows: 1000 },
      [schemaName, tableName]
    );

    return result.rows.map((row: any) => ({
      name: row.trigger_name,
      timing: row.trigger_timing,
      events: row.trigger_events || [],
      enabled: row.trigger_enabled,
      definition: row.trigger_definition,
    }));
  } catch {
    return [];
  }
}

/**
 * Get PostgreSQL sequences owned by table columns.
 */
async function getPostgresOwnedSequences(
  connector: Connector,
  tableName: string,
  schemaName: string
): Promise<PostgresSequenceDetail[]> {
  if (connector.id !== "postgres") {
    return [];
  }

  try {
    const result = await connector.executeSQL(
      `
      SELECT
        seq_ns.nspname AS sequence_schema,
        seq.relname AS sequence_name,
        att.attname AS owner_column
      FROM pg_catalog.pg_class tbl
      JOIN pg_catalog.pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      JOIN pg_catalog.pg_depend dep ON dep.refobjid = tbl.oid
      JOIN pg_catalog.pg_class seq ON seq.oid = dep.objid
      JOIN pg_catalog.pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
      LEFT JOIN pg_catalog.pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
      WHERE tbl_ns.nspname = $1
      AND tbl.relname = $2
      AND seq.relkind = 'S'
      AND dep.deptype IN ('a', 'n')
      ORDER BY seq_ns.nspname, seq.relname
    `,
      { maxRows: 1000 },
      [schemaName, tableName]
    );

    return result.rows.map((row: any) => ({
      schema: row.sequence_schema,
      name: row.sequence_name,
      owner_column: row.owner_column ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Search for schemas
 */
async function searchSchemas(
  connector: Connector,
  pattern: string,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const schemas = await connector.getSchemas();
  const regex = likePatternToRegex(pattern);
  const matched = schemas.filter((schema: string) => regex.test(schema)).slice(0, limit);

  if (detailLevel === "names") {
    return matched.map((name: string) => ({ name }));
  }

  // For summary and full, add table count
  const results = await Promise.all(
    matched.map(async (schemaName: string) => {
      try {
        const tables = await connector.getTables(schemaName);
        return {
          name: schemaName,
          table_count: tables.length,
        };
      } catch (error) {
        return {
          name: schemaName,
          table_count: 0,
        };
      }
    })
  );

  return results;
}

/**
 * Search for tables
 */
async function searchTables(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search tables in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const tables = await connector.getTables(schemaName);
      const matched = tables.filter((table: string) => regex.test(table));

      for (const tableName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: tableName,
            schema: schemaName,
          });
        } else if (detailLevel === "summary") {
          // Get column count and table comment for summary
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);
            const comment = await getTableComment(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
              ...(comment ? { comment } : {}),
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              column_count: null,
              row_count: null,
            });
          }
        } else {
          // full detail
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const indexes = await connector.getTableIndexes(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);
            const comment = await getTableComment(connector, tableName, schemaName);
            const relationKind = await getPostgresRelationKind(connector, tableName, schemaName);
            const foreignKeys = await getPostgresForeignKeys(connector, tableName, schemaName);
            const triggers = await getPostgresTriggers(connector, tableName, schemaName);
            const sequences = await getPostgresOwnedSequences(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
              ...(comment ? { comment } : {}),
              ...(relationKind ? { relation_kind: relationKind } : {}),
              columns: columns.map((col: any) => ({
                name: col.column_name,
                type: col.data_type,
                nullable: col.is_nullable === "YES",
                default: col.column_default,
                ...(col.description ? { description: col.description } : {}),
              })),
              indexes: indexes.map((idx: any) => ({
                name: idx.index_name,
                columns: idx.column_names,
                unique: idx.is_unique,
                primary: idx.is_primary,
              })),
              ...(connector.id === "postgres"
                ? {
                    foreign_keys: foreignKeys,
                    triggers,
                    sequences,
                  }
                : {}),
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              error: `Unable to fetch full details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for columns
 */
async function searchColumns(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search columns in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        tablesToSearch = await connector.getTables(schemaName);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const columns = await connector.getTableSchema(tableName, schemaName);
          const matchedColumns = columns.filter((col: any) => regex.test(col.column_name));

          for (const column of matchedColumns) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for columns
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
                type: column.data_type,
                nullable: column.is_nullable === "YES",
                default: column.column_default,
                ...(column.description ? { description: column.description } : {}),
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for stored procedures and/or functions
 * @param routineType Optional filter: "procedure" for procedures only, "function" for functions only.
 *   If not provided, returns both.
 */
async function searchProcedures(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number,
  routineType?: "procedure" | "function"
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search procedures/functions in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const procedures = await connector.getStoredProcedures(schemaName, routineType);
      const matched = procedures.filter((proc: string) => regex.test(proc));

      for (const procName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: procName,
            schema: schemaName,
          });
        } else {
          // summary and full - get procedure details
          try {
            const details = await connector.getStoredProcedureDetail(procName, schemaName);
            results.push({
              name: procName,
              schema: schemaName,
              type: details.procedure_type,
              language: details.language,
              parameters: detailLevel === "full" ? details.parameter_list : undefined,
              return_type: details.return_type,
              definition: detailLevel === "full" ? details.definition : undefined,
            });
          } catch (error) {
            results.push({
              name: procName,
              schema: schemaName,
              error: `Unable to fetch details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access or databases that don't support procedures
      continue;
    }
  }

  return results;
}

/**
 * Search for indexes
 */
async function searchIndexes(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search indexes in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        tablesToSearch = await connector.getTables(schemaName);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const indexes = await connector.getTableIndexes(tableName, schemaName);
          const matchedIndexes = indexes.filter((idx: any) => regex.test(idx.index_name));

          for (const index of matchedIndexes) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for indexes
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
                columns: index.column_names,
                unique: index.is_unique,
                primary: index.is_primary,
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Create a search_database_objects tool handler
 */
export function createSearchDatabaseObjectsToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      object_type,
      pattern = "%",
      schema,
      table,
      detail_level = "names",
      limit = 100,
    } = args as {
      object_type: DatabaseObjectType;
      pattern?: string;
      schema?: string;
      table?: string;
      detail_level: DetailLevel;
      limit: number;
    };

    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      const connector = ConnectorManager.getCurrentConnector(sourceId);

      // Tool is already registered, so it's enabled (no need to check)

      // Validate table parameter
      if (table) {
        if (!schema) {
          success = false;
          errorMessage = "The 'table' parameter requires 'schema' to be specified";
          return createToolErrorResponse(errorMessage, "SCHEMA_REQUIRED");
        }
        if (!["column", "index"].includes(object_type)) {
          success = false;
          errorMessage = `The 'table' parameter only applies to object_type 'column' or 'index', not '${object_type}'`;
          return createToolErrorResponse(errorMessage, "INVALID_TABLE_FILTER");
        }
      }

      // Validate schema if provided
      if (schema) {
        const schemas = await connector.getSchemas();
        if (!schemas.includes(schema)) {
          success = false;
          errorMessage = `Schema '${schema}' does not exist. Available schemas: ${schemas.join(", ")}`;
          return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
        }
      }

      let results: any[] = [];

      // Route to appropriate search function
      switch (object_type) {
        case "schema":
          results = await searchSchemas(connector, pattern, detail_level, limit);
          break;
        case "table":
          results = await searchTables(connector, pattern, schema, detail_level, limit);
          break;
        case "column":
          results = await searchColumns(connector, pattern, schema, table, detail_level, limit);
          break;
        case "procedure":
          results = await searchProcedures(connector, pattern, schema, detail_level, limit, "procedure");
          break;
        case "function":
          results = await searchProcedures(connector, pattern, schema, detail_level, limit, "function");
          break;
        case "index":
          results = await searchIndexes(connector, pattern, schema, table, detail_level, limit);
          break;
        default:
          success = false;
          errorMessage = `Unsupported object_type: ${object_type}`;
          return createToolErrorResponse(errorMessage, "INVALID_OBJECT_TYPE");
      }

      return createToolSuccessResponse({
        object_type,
        pattern,
        schema,
        table,
        detail_level,
        count: results.length,
        results,
        truncated: results.length === limit,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error searching database objects: ${errorMessage}`,
        "SEARCH_ERROR"
      );
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "search_objects" : `search_objects_${effectiveSourceId}`,
          sql: `search_objects(object_type=${object_type}, pattern=${pattern}, schema=${schema || "all"}, table=${table || "all"}, detail_level=${detail_level})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
