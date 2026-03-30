import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolErrorResponse, createToolSuccessResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";

export const diagnoseLocksSchema = {
  min_wait_seconds: z
    .number()
    .int()
    .nonnegative()
    .max(86400)
    .default(5)
    .describe("Minimum lock wait age in seconds (default: 5)"),
  include_idle_sessions: z
    .boolean()
    .default(false)
    .describe("Include sessions in idle states (default: false)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum rows to return (default: 20, max: 100)"),
};

const DIAGNOSE_LOCKS_SQL = `
WITH waiting AS (
  SELECT
    a.pid AS waiting_pid,
    a.usename AS waiting_user,
    a.application_name AS waiting_application,
    a.client_addr::text AS waiting_client_addr,
    a.wait_event_type,
    a.wait_event,
    a.state AS waiting_state,
    a.query_start,
    EXTRACT(EPOCH FROM (now() - a.query_start))::bigint AS waiting_seconds,
    a.query AS waiting_query,
    pg_blocking_pids(a.pid) AS blocking_pids
  FROM pg_stat_activity a
  WHERE cardinality(pg_blocking_pids(a.pid)) > 0
),
expanded AS (
  SELECT
    w.*,
    b.blocking_pid
  FROM waiting w
  CROSS JOIN LATERAL unnest(w.blocking_pids) AS b(blocking_pid)
),
blocking AS (
  SELECT
    e.waiting_pid,
    e.waiting_user,
    e.waiting_application,
    e.waiting_client_addr,
    e.wait_event_type,
    e.wait_event,
    e.waiting_state,
    e.query_start,
    e.waiting_seconds,
    e.waiting_query,
    e.blocking_pid,
    ba.usename AS blocking_user,
    ba.application_name AS blocking_application,
    ba.client_addr::text AS blocking_client_addr,
    ba.state AS blocking_state,
    EXTRACT(EPOCH FROM (now() - ba.query_start))::bigint AS blocking_query_seconds,
    ba.query AS blocking_query
  FROM expanded e
  LEFT JOIN pg_stat_activity ba ON ba.pid = e.blocking_pid
)
SELECT
  waiting_pid,
  waiting_user,
  waiting_application,
  waiting_client_addr,
  wait_event_type,
  wait_event,
  waiting_state,
  query_start,
  waiting_seconds,
  waiting_query,
  blocking_pid,
  blocking_user,
  blocking_application,
  blocking_client_addr,
  blocking_state,
  blocking_query_seconds,
  blocking_query
FROM blocking
WHERE waiting_seconds >= $1
ORDER BY waiting_seconds DESC, waiting_pid, blocking_pid
LIMIT $2
`;

export function createDiagnoseLocksToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      min_wait_seconds = 5,
      include_idle_sessions = false,
      limit = 20,
    } = args as { min_wait_seconds?: number; include_idle_sessions?: boolean; limit?: number };

    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      if (connector.id !== "postgres") {
        success = false;
        errorMessage = "diagnose_locks is only available for PostgreSQL sources";
        return createToolErrorResponse(errorMessage, "UNSUPPORTED_DATABASE");
      }

      const result = await connector.executeSQL(
        DIAGNOSE_LOCKS_SQL,
        { readonly: true, maxRows: limit },
        [min_wait_seconds, limit]
      );

      const rows = include_idle_sessions
        ? result.rows
        : result.rows.filter((row) => {
            const waitingState = String(row.waiting_state || "");
            const blockingState = String(row.blocking_state || "");
            return !waitingState.startsWith("idle") && !blockingState.startsWith("idle");
          });

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        min_wait_seconds,
        include_idle_sessions,
        count: rows.length,
        locks: rows,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "LOCK_DIAGNOSTICS_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "diagnose_locks" : `diagnose_locks_${effectiveSourceId}`,
          sql: "diagnose_locks(min_wait_seconds, include_idle_sessions, limit)",
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
