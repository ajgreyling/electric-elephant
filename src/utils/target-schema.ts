import type { Connector } from "../connectors/interface.js";
import { assertSchemaAllowed, type SchemaScopeResult } from "./sql-schema-scope.js";

/**
 * Validate target schema argument and optional allowlist from tool config.
 */
export function validateTargetSchemaArg(
  schema: string | undefined,
  allowedSchemas?: string[]
): SchemaScopeResult {
  return assertSchemaAllowed(schema ?? "", allowedSchemas);
}

/**
 * Check whether a schema exists without leaking the full schema list in errors.
 */
export async function schemaExists(connector: Connector, schema: string): Promise<boolean> {
  const schemas = await connector.getSchemas();
  return schemas.some((candidate) => candidate.toLowerCase() === schema.toLowerCase());
}

/**
 * Resolve the first schema from a source search_path configuration.
 */
export function defaultSchemaFromSearchPath(searchPath?: string): string | undefined {
  if (!searchPath || searchPath.trim().length === 0) {
    return undefined;
  }
  const first = searchPath.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}
