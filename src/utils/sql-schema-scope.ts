import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

export type SchemaScopeFailureReason =
  | "session_mutation"
  | "catalog_access"
  | "cross_schema_reference";

export type SchemaScopeFailure = {
  ok: false;
  reason: SchemaScopeFailureReason;
  message: string;
  reference?: string;
};

export type SchemaScopeSuccess = { ok: true };

export type SchemaScopeResult = SchemaScopeSuccess | SchemaScopeFailure;

const BLOCKED_SCHEMAS = new Set([
  "information_schema",
  "pg_catalog",
  "pg_toast",
  "pg_temp",
  "pg_temp_1",
]);

const QUALIFIED_NAME_PATTERN =
  /(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*\.\s*(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/g;

const TABLE_CONTEXT_PATTERN =
  /\b(FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE|COPY|DELETE\s+FROM|INSERT\s+INTO)\s+(?:ONLY\s+)?(?:LATERAL\s+)?/gi;

function normalizeSchemaName(name: string): string {
  return name.toLowerCase();
}

function isBlockedSchema(schemaName: string): boolean {
  const normalized = normalizeSchemaName(schemaName);
  return (
    BLOCKED_SCHEMAS.has(normalized) ||
    normalized.startsWith("pg_temp") ||
    normalized.startsWith("pg_toast")
  );
}

function schemasMatch(left: string, right: string): boolean {
  return normalizeSchemaName(left) === normalizeSchemaName(right);
}

function extractQualifiedName(match: RegExpExecArray): { schema: string; object: string } {
  const schema = match[1] ?? match[2]!;
  const object = match[3] ?? match[4]!;
  return { schema, object };
}

function checkQualifiedReference(
  schemaPart: string,
  targetSchema: string
): SchemaScopeFailure | null {
  if (isBlockedSchema(schemaPart)) {
    return {
      ok: false,
      reason: "catalog_access",
      message: `Access to system catalog schema '${schemaPart}' is not allowed in scoped SQL`,
      reference: schemaPart,
    };
  }

  if (!schemasMatch(schemaPart, targetSchema)) {
    return {
      ok: false,
      reason: "cross_schema_reference",
      message: `Cross-schema reference '${schemaPart}' is not allowed; queries must target schema '${targetSchema}' only`,
      reference: schemaPart,
    };
  }

  return null;
}

function validateSessionMutation(statement: string): SchemaScopeFailure | null {
  const stripped = stripCommentsAndStrings(statement).trim();
  const upper = stripped.toUpperCase();
  if (/^(SET|RESET)\b/.test(upper)) {
    return {
      ok: false,
      reason: "session_mutation",
      message: "SET and RESET statements are not allowed in scoped SQL",
    };
  }
  return null;
}

function validateQualifiedReferencesInSegment(
  segment: string,
  targetSchema: string
): SchemaScopeFailure | null {
  QUALIFIED_NAME_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUALIFIED_NAME_PATTERN.exec(segment)) !== null) {
    const { schema } = extractQualifiedName(match);
    const violation = checkQualifiedReference(schema, targetSchema);
    if (violation) {
      return violation;
    }
  }
  return null;
}

function validateTableContextReferences(
  statement: string,
  targetSchema: string
): SchemaScopeFailure | null {
  const stripped = stripCommentsAndStrings(statement);
  TABLE_CONTEXT_PATTERN.lastIndex = 0;
  let contextMatch: RegExpExecArray | null;

  while ((contextMatch = TABLE_CONTEXT_PATTERN.exec(stripped)) !== null) {
    const segmentStart = contextMatch.index + contextMatch[0].length;
    const segmentEnd = findSegmentEnd(stripped, segmentStart);
    const segment = stripped.slice(segmentStart, segmentEnd);
    const violation = validateQualifiedReferencesInSegment(segment, targetSchema);
    if (violation) {
      return violation;
    }
  }

  return null;
}

function findSegmentEnd(sql: string, start: number): number {
  const terminators = /\b(WHERE|SET|RETURNING|ON|USING|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|FOR|WINDOW)\b/gi;
  terminators.lastIndex = start;
  const match = terminators.exec(sql);
  return match ? match.index : sql.length;
}

function validateGlobalQualifiedReferences(
  statement: string,
  targetSchema: string
): SchemaScopeFailure | null {
  const stripped = stripCommentsAndStrings(statement);
  QUALIFIED_NAME_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = QUALIFIED_NAME_PATTERN.exec(stripped)) !== null) {
    const { schema } = extractQualifiedName(match);
    if (!isBlockedSchema(schema)) {
      continue;
    }
    const violation = checkQualifiedReference(schema, targetSchema);
    if (violation) {
      return violation;
    }
  }

  return null;
}

/**
 * Validate that SQL is scoped to a single target schema.
 * Blocks session mutation, catalog access, and cross-schema qualified references.
 */
export function validateSqlSchemaScope(sql: string, targetSchema: string): SchemaScopeResult {
  if (!targetSchema || targetSchema.trim().length === 0) {
    return {
      ok: false,
      reason: "cross_schema_reference",
      message: "Target schema is required for scoped SQL execution",
    };
  }

  const statements = splitSQLStatements(sql);
  for (const statement of statements) {
    const sessionViolation = validateSessionMutation(statement);
    if (sessionViolation) {
      return sessionViolation;
    }

    const catalogViolation = validateGlobalQualifiedReferences(statement, targetSchema);
    if (catalogViolation) {
      return catalogViolation;
    }

    const contextViolation = validateTableContextReferences(statement, targetSchema);
    if (contextViolation) {
      return contextViolation;
    }
  }

  return { ok: true };
}

/**
 * Validate that a target schema argument is allowed by optional tool configuration.
 */
export function assertSchemaAllowed(
  schema: string,
  allowedSchemas?: string[]
): SchemaScopeResult {
  if (!schema || schema.trim().length === 0) {
    return {
      ok: false,
      reason: "cross_schema_reference",
      message: "The 'schema' parameter is required",
    };
  }

  if (!allowedSchemas || allowedSchemas.length === 0) {
    return { ok: true };
  }

  const allowed = allowedSchemas.some((candidate) => schemasMatch(candidate, schema));
  if (!allowed) {
    return {
      ok: false,
      reason: "cross_schema_reference",
      message: `Schema '${schema}' is not in the allowed schemas for this tool`,
    };
  }

  return { ok: true };
}

/**
 * Validate static SQL at registration time when no default schema is configured.
 * Blocks session mutation and catalog access only.
 */
export function validateStaticSqlPolicy(sql: string): SchemaScopeResult {
  const statements = splitSQLStatements(sql);
  for (const statement of statements) {
    const sessionViolation = validateSessionMutation(statement);
    if (sessionViolation) {
      return sessionViolation;
    }

    const stripped = stripCommentsAndStrings(statement);
    QUALIFIED_NAME_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUALIFIED_NAME_PATTERN.exec(stripped)) !== null) {
      const { schema } = extractQualifiedName(match);
      if (isBlockedSchema(schema)) {
        return {
          ok: false,
          reason: "catalog_access",
          message: `Access to system catalog schema '${schema}' is not allowed in scoped SQL`,
          reference: schema,
        };
      }
    }
  }

  return { ok: true };
}
