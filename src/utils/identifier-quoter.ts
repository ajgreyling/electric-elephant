/**
 * Quote a PostgreSQL identifier (table name, schema name, column name) for safe use in SQL.
 * Handles escaping of double quotes within identifiers and validation against control characters.
 *
 * For identifiers from database metadata, not raw user input (use parameters for user values).
 */
export function quoteIdentifier(identifier: string): string {
  if (/[\0\x08\x09\x1a\n\r]/.test(identifier)) {
    throw new Error(`Invalid identifier: contains control characters: ${identifier}`);
  }

  if (!identifier) {
    throw new Error("Identifier cannot be empty");
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Quote a qualified identifier (schema.table)
 */
export function quoteQualifiedIdentifier(
  tableName: string,
  schemaName: string | undefined
): string {
  const quotedTable = quoteIdentifier(tableName);

  if (schemaName) {
    const quotedSchema = quoteIdentifier(schemaName);
    return `${quotedSchema}.${quotedTable}`;
  }

  return quotedTable;
}
