/**
 * PostgreSQL error sanitization.
 *
 * `pg` errors carry fields beyond `.message` — notably `.detail`, `.hint`,
 * `.where`, `.internalQuery`, and `.query` — that can echo row VALUES back to a
 * caller (e.g. a unique-violation detail: "Key (email)=(bob@x.com) already
 * exists"). Only `.message` is surfaced today, but that is a fragile, implicit
 * guarantee. This normalizes any thrown value into a plain Error whose message
 * is safe to return/log and which does NOT carry the sensitive fields.
 */

/** Fields on a pg error that may contain row values or raw SQL. */
const SENSITIVE_PG_ERROR_FIELDS = [
  "detail",
  "hint",
  "where",
  "internalQuery",
  "query",
  "internalPosition",
] as const;

interface PgLikeError {
  message?: unknown;
  code?: unknown;
  detail?: unknown;
}

/**
 * Return a sanitized, safe-to-surface Error for any thrown value.
 *
 * - Keeps `.message` (the base PostgreSQL error text, which does not include the
 *   detail/hint value fields) and the SQLSTATE `.code`.
 * - Never copies `.detail` / `.hint` / `.where` / `.internalQuery` / `.query`.
 */
export function sanitizePgError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(typeof error === "string" ? error : "Unknown database error");
  }

  const pgErr = error as Error & PgLikeError;
  // The base message is the PostgreSQL error summary; the value-bearing fields
  // (detail/hint/etc.) live separately and are intentionally never carried over.
  const safeMessage = String(pgErr.message ?? "Database error");

  const sanitized = new Error(safeMessage);
  sanitized.name = pgErr.name || "Error";
  // Preserve the SQLSTATE code (not sensitive; useful for callers).
  if (typeof pgErr.code === "string") {
    (sanitized as Error & { code?: string }).code = pgErr.code;
  }
  // Explicitly do NOT carry over the sensitive fields.
  for (const field of SENSITIVE_PG_ERROR_FIELDS) {
    if (field in sanitized) {
      delete (sanitized as Record<string, unknown>)[field];
    }
  }
  return sanitized;
}
