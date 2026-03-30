import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";

type QueryResult = {
  available: boolean;
  rows: any[];
  warning?: string;
};

async function runReadOnlyQuery(
  sourceId: string | undefined,
  sql: string,
  warningPrefix: string,
  parameters?: any[]
): Promise<QueryResult> {
  try {
    const connector = ConnectorManager.getCurrentConnector(sourceId);
    const result = await connector.executeSQL(sql, { readonly: true }, parameters);
    return {
      available: true,
      rows: result.rows,
    };
  } catch (error) {
    return {
      available: false,
      rows: [],
      warning: `${warningPrefix}: ${(error as Error).message}`,
    };
  }
}

export const replicationStatusSchema = {
  include_replication_slots: z
    .boolean()
    .default(true)
    .describe("Include pg_replication_slots health details"),
};

export function createReplicationStatusToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { include_replication_slots = true } = args as { include_replication_slots?: boolean };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);

      const serverRoleResult = await runReadOnlyQuery(
        sourceId,
        `SELECT
           pg_is_in_recovery() AS is_replica,
           current_setting('server_version') AS server_version,
           current_setting('server_version_num') AS server_version_num`,
        "Could not inspect server role"
      );

      const replicationClientsResult = await runReadOnlyQuery(
        sourceId,
        `SELECT
           application_name,
           client_addr::text AS client_addr,
           state,
           sync_state,
           sent_lsn::text AS sent_lsn,
           write_lsn::text AS write_lsn,
           flush_lsn::text AS flush_lsn,
           replay_lsn::text AS replay_lsn,
           write_lag,
           flush_lag,
           replay_lag
         FROM pg_stat_replication
         ORDER BY application_name`,
        "Could not query pg_stat_replication"
      );

      const replicaLagResult = await runReadOnlyQuery(
        sourceId,
        `SELECT
           pg_last_wal_receive_lsn()::text AS last_wal_receive_lsn,
           pg_last_wal_replay_lsn()::text AS last_wal_replay_lsn,
           pg_last_xact_replay_timestamp() AS last_xact_replay_timestamp`,
        "Could not query replica replay status"
      );

      const replicationSlotsResult = include_replication_slots
        ? await runReadOnlyQuery(
            sourceId,
            `SELECT
               slot_name,
               slot_type,
               active,
               temporary,
               restart_lsn::text AS restart_lsn,
               confirmed_flush_lsn::text AS confirmed_flush_lsn,
               wal_status,
               safe_wal_size
             FROM pg_replication_slots
             ORDER BY slot_name`,
            "Could not query pg_replication_slots"
          )
        : { available: false, rows: [] };

      const warnings = [
        serverRoleResult.warning,
        replicationClientsResult.warning,
        replicaLagResult.warning,
        replicationSlotsResult.warning,
      ].filter(Boolean);

      const roleInfo = serverRoleResult.rows[0] || {};
      const isReplica = roleInfo.is_replica === true;
      const replicationLag = replicaLagResult.rows[0] || {};

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        is_replica: isReplica,
        server_version: roleInfo.server_version ?? null,
        server_version_num: roleInfo.server_version_num ?? null,
        streaming_clients_available: replicationClientsResult.available,
        streaming_clients: replicationClientsResult.rows,
        replica_replay_status_available: replicaLagResult.available,
        replica_replay_status: replicationLag,
        replication_slots_available: include_replication_slots
          ? replicationSlotsResult.available
          : false,
        replication_slots: include_replication_slots ? replicationSlotsResult.rows : [],
        warnings,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error fetching replication status: ${errorMessage}`,
        "REPLICATION_STATUS_ERROR"
      );
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName:
            effectiveSourceId === "default"
              ? "replication_status"
              : `replication_status_${effectiveSourceId}`,
          sql: "replication_status()",
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}

export const tableHealthSchema = {
  schema: z
    .string()
    .optional()
    .describe("Optional schema filter (defaults to all non-system schemas)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(100)
    .describe("Maximum number of tables to return (default: 100, max: 500)"),
};

export function createTableHealthToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { schema, limit = 100 } = args as { schema?: string; limit?: number };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);

      const tableHealthResult = await runReadOnlyQuery(
        sourceId,
        `SELECT
           st.schemaname AS schema_name,
           st.relname AS table_name,
           st.n_live_tup::bigint AS estimated_live_rows,
           st.n_dead_tup::bigint AS estimated_dead_rows,
           CASE
             WHEN (st.n_live_tup + st.n_dead_tup) = 0 THEN 0
             ELSE ROUND((st.n_dead_tup::numeric / (st.n_live_tup + st.n_dead_tup)::numeric) * 100, 2)
           END AS dead_tuple_pct,
           st.last_vacuum,
           st.last_autovacuum,
           st.last_analyze,
           st.last_autoanalyze,
           st.vacuum_count::bigint AS vacuum_count,
           st.autovacuum_count::bigint AS autovacuum_count,
           st.analyze_count::bigint AS analyze_count,
           st.autoanalyze_count::bigint AS autoanalyze_count,
           pg_total_relation_size(c.oid)::bigint AS total_bytes,
           pg_relation_size(c.oid)::bigint AS table_bytes
         FROM pg_stat_user_tables st
         JOIN pg_class c ON c.relname = st.relname
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE st.schemaname = n.nspname
           AND ($1::text IS NULL OR st.schemaname = $1)
         ORDER BY dead_tuple_pct DESC, estimated_dead_rows DESC
         LIMIT $2`,
        "Could not query table health from pg_stat_user_tables",
        [schema ?? null, limit]
      );

      let fallbackTables: any[] = [];
      if (!tableHealthResult.available) {
        const fallbackResult = await runReadOnlyQuery(
          sourceId,
          `SELECT
             table_schema AS schema_name,
             table_name
           FROM information_schema.tables
           WHERE table_type = 'BASE TABLE'
             AND table_schema NOT IN ('pg_catalog', 'information_schema')
             AND ($1::text IS NULL OR table_schema = $1)
           ORDER BY table_schema, table_name
           LIMIT $2`,
          "Could not query fallback table list from information_schema.tables",
          [schema ?? null, limit]
        );
        fallbackTables = fallbackResult.rows.map((row) => ({
          ...row,
          estimated_live_rows: null,
          estimated_dead_rows: null,
          dead_tuple_pct: null,
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
          last_autoanalyze: null,
          vacuum_count: null,
          autovacuum_count: null,
          analyze_count: null,
          autoanalyze_count: null,
          total_bytes: null,
          table_bytes: null,
        }));
        if (fallbackResult.warning) {
          tableHealthResult.warning = tableHealthResult.warning
            ? `${tableHealthResult.warning}; ${fallbackResult.warning}`
            : fallbackResult.warning;
        }
      }

      const warnings = [tableHealthResult.warning].filter(Boolean);
      const rows = tableHealthResult.available ? tableHealthResult.rows : fallbackTables;

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        schema_filter: schema ?? null,
        stats_available: tableHealthResult.available,
        count: rows.length,
        tables: rows,
        warnings,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error fetching table health: ${errorMessage}`,
        "TABLE_HEALTH_ERROR"
      );
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName:
            effectiveSourceId === "default" ? "table_health" : `table_health_${effectiveSourceId}`,
          sql: `table_health(schema=${schema ?? "all"}, limit=${limit})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}

export const extensionsStatusSchema = {
  include_available: z
    .boolean()
    .default(true)
    .describe("Include available-but-not-installed extensions list"),
};

export function createExtensionsStatusToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { include_available = true } = args as { include_available?: boolean };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);

      const installedResult = await runReadOnlyQuery(
        sourceId,
        `SELECT
           extname AS name,
           extversion AS version,
           extrelocatable AS relocatable
         FROM pg_extension
         ORDER BY extname`,
        "Could not query installed extensions from pg_extension"
      );

      const availableResult = include_available
        ? await runReadOnlyQuery(
            sourceId,
            `SELECT
               name,
               default_version,
               installed_version,
               comment
             FROM pg_available_extensions
             ORDER BY name`,
            "Could not query available extensions from pg_available_extensions"
          )
        : { available: false, rows: [] };

      const pgStatStatementsInstallResult = await runReadOnlyQuery(
        sourceId,
        `SELECT EXISTS (
           SELECT 1
           FROM pg_extension
           WHERE extname = 'pg_stat_statements'
         ) AS installed`,
        "Could not verify pg_stat_statements installation state"
      );

      const pgStatStatementsInfoResult = await runReadOnlyQuery(
        sourceId,
        `SELECT stats_reset
         FROM pg_stat_statements_info
         LIMIT 1`,
        "Could not query pg_stat_statements_info (view may be unavailable)"
      );

      const preloadLibrariesResult = await runReadOnlyQuery(
        sourceId,
        `SELECT current_setting('shared_preload_libraries', true) AS shared_preload_libraries`,
        "Could not read shared_preload_libraries setting"
      );

      const preloadLibraries = preloadLibrariesResult.rows[0]?.shared_preload_libraries ?? "";
      const hasPgStatStatementsPreload = String(preloadLibraries)
        .split(",")
        .map((item: string) => item.trim())
        .filter(Boolean)
        .includes("pg_stat_statements");

      const warnings = [
        installedResult.warning,
        availableResult.warning,
        pgStatStatementsInstallResult.warning,
        pgStatStatementsInfoResult.warning,
        preloadLibrariesResult.warning,
      ].filter(Boolean);

      const installed = pgStatStatementsInstallResult.rows[0]?.installed === true;
      const active = pgStatStatementsInfoResult.available;

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        installed_extensions_available: installedResult.available,
        installed_extensions: installedResult.rows,
        available_extensions_available: include_available ? availableResult.available : false,
        available_extensions: include_available ? availableResult.rows : [],
        pg_stat_statements: {
          installed,
          info_view_available: active,
          shared_preload_libraries: preloadLibraries || null,
          preloaded: hasPgStatStatementsPreload,
          stats_reset: pgStatStatementsInfoResult.rows[0]?.stats_reset ?? null,
        },
        warnings,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error fetching extensions status: ${errorMessage}`,
        "EXTENSIONS_STATUS_ERROR"
      );
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName:
            effectiveSourceId === "default"
              ? "extensions_status"
              : `extensions_status_${effectiveSourceId}`,
          sql: "extensions_status()",
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
