import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";
import type { TableColumn, TableIndex } from "../connectors/interface.js";

const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

function isUserSchema(name: string): boolean {
  if (SYSTEM_SCHEMAS.has(name)) {
    return false;
  }
  if (name.startsWith("pg_toast")) {
    return false;
  }
  if (name.startsWith("pg_temp_")) {
    return false;
  }
  return true;
}

export const schemaDiffObjectType = z.enum([
  "schema",
  "table",
  "column",
  "index",
  "function",
  "procedure",
]);

export const schemaDiffSchema = {
  right_source: z
    .string()
    .min(1)
    .describe("Other source id to compare with (a configured [[sources]] id)"),
  schema: z.string().optional().describe("Limit comparison to this single schema"),
  object_types: z
    .array(schemaDiffObjectType)
    .optional()
    .describe(
      "Object kinds to compare (default: schema, table, column, index). Include function/procedure for routines."
    ),
  include_definitions: z
    .boolean()
    .default(false)
    .describe("When true, include routine definitions in routine_diffs (larger response)"),
  max_tables: z
    .number()
    .int()
    .positive()
    .max(2000)
    .default(500)
    .describe("Maximum tables to load per schema per side (caps work for large databases)"),
};

type ObjectType = z.infer<typeof schemaDiffObjectType>;

const DEFAULT_OBJECT_TYPES: ObjectType[] = ["schema", "table", "column", "index"];

function colSignature(c: TableColumn): string {
  const def = c.column_default == null ? "" : String(c.column_default);
  return `${c.data_type}|${c.is_nullable}|${def}`;
}

function indexSignature(i: TableIndex): string {
  const cols = [...i.column_names].join(",");
  return `${i.is_unique}|${i.is_primary}|${cols}`;
}

function setDiff(left: Set<string>, right: Set<string>): {
  only_in_left: string[];
  only_in_right: string[];
} {
  const only_in_left: string[] = [];
  const only_in_right: string[] = [];
  for (const x of left) {
    if (!right.has(x)) {
      only_in_left.push(x);
    }
  }
  for (const x of right) {
    if (!left.has(x)) {
      only_in_right.push(x);
    }
  }
  only_in_left.sort();
  only_in_right.sort();
  return { only_in_left, only_in_right };
}

export function createSchemaDiffToolHandler(leftSourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      right_source,
      schema: schemaFilter,
      object_types: objectTypesArg,
      include_definitions = false,
      max_tables = 500,
    } = args as {
      right_source: string;
      schema?: string;
      object_types?: ObjectType[];
      include_definitions?: boolean;
      max_tables?: number;
    };

    const startTime = Date.now();
    const leftId = leftSourceId || ConnectorManager.getAvailableSourceIds()[0];
    const effectiveLeft = getEffectiveSourceId(leftId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      const allIds = ConnectorManager.getAvailableSourceIds();
      if (allIds.length < 2) {
        success = false;
        errorMessage =
          "schema_diff requires at least two configured database sources (e.g. two [[sources]] entries in dbhub.toml).";
        return createToolErrorResponse(errorMessage, "SCHEMA_DIFF_INSUFFICIENT_SOURCES");
      }

      if (right_source === leftId) {
        success = false;
        errorMessage = "right_source must differ from the tool's source (left side)";
        return createToolErrorResponse(errorMessage, "SCHEMA_DIFF_INVALID_SOURCES");
      }

      if (!allIds.includes(right_source)) {
        success = false;
        errorMessage = `Unknown right_source '${right_source}'. Available: ${allIds.join(", ")}`;
        return createToolErrorResponse(errorMessage, "SCHEMA_DIFF_UNKNOWN_SOURCE");
      }

      await ConnectorManager.ensureConnected(leftId);
      await ConnectorManager.ensureConnected(right_source);

      const leftConn = ConnectorManager.getCurrentConnector(leftId);
      const rightConn = ConnectorManager.getCurrentConnector(right_source);

      if (leftConn.id !== "postgres" || rightConn.id !== "postgres") {
        success = false;
        errorMessage = "schema_diff is only available for PostgreSQL sources";
        return createToolErrorResponse(errorMessage, "UNSUPPORTED_DATABASE");
      }

      const objectTypes: ObjectType[] = objectTypesArg?.length
        ? objectTypesArg
        : DEFAULT_OBJECT_TYPES;

      const warnings: string[] = [];
      let tablesTruncated = false;

      /** Schema-level */
      const schemasOnlyLeft: string[] = [];
      const schemasOnlyRight: string[] = [];
      const commonSchemas: string[] = [];

      const leftSchemasFull = (await leftConn.getSchemas()).filter(isUserSchema);
      const rightSchemasFull = (await rightConn.getSchemas()).filter(isUserSchema);

      const leftSchemaSet = new Set(leftSchemasFull);
      const rightSchemaSet = new Set(rightSchemasFull);

      if (objectTypes.includes("schema")) {
        const { only_in_left, only_in_right } = setDiff(leftSchemaSet, rightSchemaSet);
        schemasOnlyLeft.push(...only_in_left);
        schemasOnlyRight.push(...only_in_right);
      }

      if (schemaFilter) {
        if (!leftSchemaSet.has(schemaFilter)) {
          warnings.push(`Schema '${schemaFilter}' not present on left source '${leftId}'`);
        }
        if (!rightSchemaSet.has(schemaFilter)) {
          warnings.push(`Schema '${schemaFilter}' not present on right source '${right_source}'`);
        }
        if (leftSchemaSet.has(schemaFilter) && rightSchemaSet.has(schemaFilter)) {
          commonSchemas.push(schemaFilter);
        }
      } else {
        for (const s of leftSchemasFull) {
          if (rightSchemaSet.has(s)) {
            commonSchemas.push(s);
          }
        }
        commonSchemas.sort();
      }

      /** Per-schema table + column + index */
      const tableDiffBySchema: Array<{
        schema: string;
        only_in_left: string[];
        only_in_right: string[];
      }> = [];

      const columnDiffs: Array<{
        schema: string;
        table: string;
        change: "column_only_in_left" | "column_only_in_right" | "column_changed";
        name?: string;
        left?: string;
        right?: string;
        severity: "info" | "warning";
      }> = [];

      const indexDiffs: Array<{
        schema: string;
        table: string;
        change: "index_only_in_left" | "index_only_in_right" | "index_changed";
        name?: string;
        left?: string;
        right?: string;
        severity: "info" | "warning";
      }> = [];

      const routineDiffs: Array<{
        schema: string;
        kind: "function" | "procedure";
        name: string;
        change: "only_in_left" | "only_in_right" | "definition_changed";
        severity: "info" | "warning";
      }> = [];

      const wantTable = objectTypes.includes("table");
      const wantColumn = objectTypes.includes("column");
      const wantIndex = objectTypes.includes("index");
      const wantFunction = objectTypes.includes("function");
      const wantProcedure = objectTypes.includes("procedure");

      for (const sch of commonSchemas) {
        let leftTables = await leftConn.getTables(sch);
        let rightTables = await rightConn.getTables(sch);

        if (leftTables.length > max_tables || rightTables.length > max_tables) {
          tablesTruncated = true;
          leftTables = leftTables.slice(0, max_tables);
          rightTables = rightTables.slice(0, max_tables);
        }

        const leftT = new Set(leftTables);
        const rightT = new Set(rightTables);

        if (wantTable || wantColumn || wantIndex) {
          const { only_in_left, only_in_right } = setDiff(leftT, rightT);
          if (wantTable && (only_in_left.length || only_in_right.length)) {
            tableDiffBySchema.push({
              schema: sch,
              only_in_left,
              only_in_right,
            });
          }

          if (wantColumn || wantIndex) {
            const commonTables = leftTables.filter((t) => rightT.has(t));
            for (const table of commonTables) {
              if (wantColumn) {
                let lCols: TableColumn[] = [];
                let rCols: TableColumn[] = [];
                try {
                  lCols = await leftConn.getTableSchema(table, sch);
                } catch {
                  columnDiffs.push({
                    schema: sch,
                    table,
                    change: "column_only_in_left",
                    severity: "warning",
                    name: "*",
                    left: "unreadable",
                    right: undefined,
                  });
                  continue;
                }
                try {
                  rCols = await rightConn.getTableSchema(table, sch);
                } catch {
                  columnDiffs.push({
                    schema: sch,
                    table,
                    change: "column_only_in_right",
                    severity: "warning",
                    name: "*",
                    left: undefined,
                    right: "unreadable",
                  });
                  continue;
                }

                const lMap = new Map(lCols.map((c) => [c.column_name, colSignature(c)]));
                const rMap = new Map(rCols.map((c) => [c.column_name, colSignature(c)]));
                for (const [name, sig] of lMap) {
                  if (!rMap.has(name)) {
                    columnDiffs.push({
                      schema: sch,
                      table,
                      change: "column_only_in_left",
                      name,
                      left: sig,
                      severity: "warning",
                    });
                  } else if (rMap.get(name) !== sig) {
                    columnDiffs.push({
                      schema: sch,
                      table,
                      change: "column_changed",
                      name,
                      left: sig,
                      right: rMap.get(name),
                      severity: "warning",
                    });
                  }
                }
                for (const [name, sig] of rMap) {
                  if (!lMap.has(name)) {
                    columnDiffs.push({
                      schema: sch,
                      table,
                      change: "column_only_in_right",
                      name,
                      right: sig,
                      severity: "warning",
                    });
                  }
                }
              }

              if (wantIndex) {
                let lIdx: TableIndex[] = [];
                let rIdx: TableIndex[] = [];
                try {
                  lIdx = await leftConn.getTableIndexes(table, sch);
                } catch {
                  indexDiffs.push({
                    schema: sch,
                    table,
                    change: "index_only_in_left",
                    severity: "warning",
                    name: "*",
                    left: "unreadable",
                  });
                  continue;
                }
                try {
                  rIdx = await rightConn.getTableIndexes(table, sch);
                } catch {
                  indexDiffs.push({
                    schema: sch,
                    table,
                    change: "index_only_in_right",
                    severity: "warning",
                    name: "*",
                    right: "unreadable",
                  });
                  continue;
                }

                const lMap = new Map(lIdx.map((i) => [i.index_name, indexSignature(i)]));
                const rMap = new Map(rIdx.map((i) => [i.index_name, indexSignature(i)]));
                for (const [name, sig] of lMap) {
                  if (!rMap.has(name)) {
                    indexDiffs.push({
                      schema: sch,
                      table,
                      change: "index_only_in_left",
                      name,
                      left: sig,
                      severity: "info",
                    });
                  } else if (rMap.get(name) !== sig) {
                    indexDiffs.push({
                      schema: sch,
                      table,
                      change: "index_changed",
                      name,
                      left: sig,
                      right: rMap.get(name),
                      severity: "warning",
                    });
                  }
                }
                for (const [name, sig] of rMap) {
                  if (!lMap.has(name)) {
                    indexDiffs.push({
                      schema: sch,
                      table,
                      change: "index_only_in_right",
                      name,
                      right: sig,
                      severity: "info",
                    });
                  }
                }
              }
            }
          }
        }

        if (wantFunction || wantProcedure) {
          const routineTypes: Array<"function" | "procedure"> = [];
          if (wantFunction) {
            routineTypes.push("function");
          }
          if (wantProcedure) {
            routineTypes.push("procedure");
          }
          for (const rt of routineTypes) {
            let leftNames: string[] = [];
            let rightNames: string[] = [];
            try {
              leftNames = await leftConn.getStoredProcedures(sch, rt);
            } catch {
              warnings.push(`Could not list ${rt}s on left source for schema ${sch}`);
              continue;
            }
            try {
              rightNames = await rightConn.getStoredProcedures(sch, rt);
            } catch {
              warnings.push(`Could not list ${rt}s on right source for schema ${sch}`);
              continue;
            }
            const lSet = new Set(leftNames);
            const rSet = new Set(rightNames);
            const { only_in_left, only_in_right } = setDiff(lSet, rSet);
            for (const n of only_in_left) {
              routineDiffs.push({
                schema: sch,
                kind: rt,
                name: n,
                change: "only_in_left",
                severity: "info",
              });
            }
            for (const n of only_in_right) {
              routineDiffs.push({
                schema: sch,
                kind: rt,
                name: n,
                change: "only_in_right",
                severity: "info",
              });
            }
            if (include_definitions) {
              const common = leftNames.filter((n) => rSet.has(n));
              for (const n of common) {
                try {
                  const lDet = await leftConn.getStoredProcedureDetail(n, sch);
                  const rDet = await rightConn.getStoredProcedureDetail(n, sch);
                  const lDef = lDet.definition ?? "";
                  const rDef = rDet.definition ?? "";
                  if (lDef !== rDef) {
                    routineDiffs.push({
                      schema: sch,
                      kind: rt,
                      name: n,
                      change: "definition_changed",
                      severity: "warning",
                    });
                  }
                } catch {
                  warnings.push(`Could not compare ${rt} ${sch}.${n}`);
                }
              }
            }
          }
        }
      }

      if (tablesTruncated) {
        warnings.push(
          `Table lists were truncated to max_tables=${max_tables} per schema; increase max_tables or set schema for a narrower diff.`
        );
      }

      const summary = {
        schemas_differ:
          schemasOnlyLeft.length > 0 ||
          schemasOnlyRight.length > 0 ||
          warnings.some((w) => w.includes("not present on")),
        tables_differ: tableDiffBySchema.length > 0,
        columns_differ: columnDiffs.length > 0,
        indexes_differ: indexDiffs.length > 0,
        routines_differ: routineDiffs.length > 0,
      };

      return createToolSuccessResponse({
        left_source: leftId,
        right_source,
        schema_filter: schemaFilter ?? null,
        object_types: objectTypes,
        include_definitions,
        truncated: tablesTruncated,
        summary,
        schemas: objectTypes.includes("schema")
          ? { only_in_left: schemasOnlyLeft, only_in_right: schemasOnlyRight }
          : { only_in_left: [], only_in_right: [] },
        table_diffs: tableDiffBySchema,
        column_diffs: columnDiffs,
        index_diffs: indexDiffs,
        routine_diffs: routineDiffs,
        warnings,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "SCHEMA_DIFF_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveLeft,
          toolName:
            effectiveLeft === "default" ? "schema_diff" : `schema_diff_${effectiveLeft}`,
          sql: `schema_diff(right_source=${right_source})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
