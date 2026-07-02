const TokenType = { Plain: 0, Comment: 1, QuotedBlock: 2, QuotedIdentifier: 3 } as const;

interface SQLToken {
  type: number;
  /** Position just past the end of this token (the next unprocessed character) */
  end: number;
}

function plainToken(i: number): SQLToken {
  return { type: TokenType.Plain, end: i + 1 };
}

function scanSingleLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "-" || sql[i + 1] !== "-") { return null; }
  let j = i;
  while (j < sql.length && sql[j] !== "\n") { j++; }
  return { type: TokenType.Comment, end: j };
}

function scanNestedMultiLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*") { return null; }
  let j = i + 2;
  let depth = 1;
  while (j < sql.length && depth > 0) {
    if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
    else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
    else { j++; }
  }
  return { type: TokenType.Comment, end: j };
}

function scanSingleQuotedString(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "'") { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; }
    else if (sql[j] === "'") { j++; break; }
    else { j++; }
  }
  return { type: TokenType.QuotedBlock, end: j };
}

function scanDoubleQuotedString(sql: string, i: number): SQLToken | null {
  if (sql[i] !== '"') { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; }
    else if (sql[j] === '"') { j++; break; }
    else { j++; }
  }
  // In PostgreSQL, double quotes delimit an IDENTIFIER (e.g. a column name), not
  // a string literal. It must be opaque for statement-splitting, but its content
  // must be PRESERVED by stripCommentsAndStrings so downstream guards still see
  // the column/table name (stripping it would erase names, bypassing the checks).
  return { type: TokenType.QuotedIdentifier, end: j };
}

// Matches $$ or $tag$ where tag is [a-zA-Z_]\w* (digits after $ do NOT start a tag, so $1 is safe)
const dollarQuoteOpenRegex = /^\$([a-zA-Z_]\w*)?\$/;

function scanDollarQuotedBlock(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "$") { return null; }
  const next = sql[i + 1];
  if (next >= "0" && next <= "9") { return null; }
  const remaining = sql.substring(i);
  const m = dollarQuoteOpenRegex.exec(remaining);
  if (!m) { return null; }
  const tag = m[0];
  const bodyStart = i + tag.length;
  const closeIdx = sql.indexOf(tag, bodyStart);
  const end = closeIdx !== -1 ? closeIdx + tag.length : sql.length;
  return { type: TokenType.QuotedBlock, end };
}

function scanTokenPostgres(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanNestedMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanDollarQuotedBlock(sql, i)
    ?? plainToken(i);
}

function stripTokens(sql: string, preserveQuotedIdentifiers: boolean): string {
  const parts: string[] = [];
  let plainStart = -1;
  let i = 0;

  while (i < sql.length) {
    const token = scanTokenPostgres(sql, i);

    const keep =
      token.type === TokenType.Plain ||
      (preserveQuotedIdentifiers && token.type === TokenType.QuotedIdentifier);

    if (keep) {
      if (plainStart === -1) { plainStart = i; }
    } else {
      if (plainStart !== -1) {
        parts.push(sql.substring(plainStart, i));
        plainStart = -1;
      }
      parts.push(" ");
    }

    i = token.end;
  }

  if (plainStart !== -1) {
    parts.push(sql.substring(plainStart));
  }

  return parts.join("");
}

/**
 * Replace comments, string literals, and PostgreSQL dollar-quoted blocks with a
 * single space each, but PRESERVE double-quoted identifiers (column/table names).
 *
 * Use this for anything that inspects identifier NAMES — the PII guard and
 * schema-scope checks — so a quoted `"email"` / `"information_schema"` cannot
 * hide from name-based detection.
 */
export function stripCommentsAndStrings(sql: string): string {
  return stripTokens(sql, /* preserveQuotedIdentifiers */ true);
}

/**
 * Like {@link stripCommentsAndStrings} but ALSO blanks out double-quoted
 * identifiers. Use this for structural keyword/parameter scanning (LIMIT
 * detection, `$n` parameter-style detection) where an identifier such as
 * `"limit 10"` or `"table$1"` must not be mistaken for SQL structure.
 */
export function stripCommentsStringsAndIdentifiers(sql: string): string {
  return stripTokens(sql, /* preserveQuotedIdentifiers */ false);
}

/**
 * Redact literal VALUES from SQL while preserving its shape, so query text can be
 * stored/returned (request history, observability) without leaking PII embedded
 * in literals (e.g. `WHERE email = 'bob@x.com'` → `WHERE email = '?'`).
 *
 * - Single-quoted strings and dollar-quoted blocks → `'?'`
 * - Numeric literals → `?`
 * - Comments → removed
 * - Identifiers (plain and double-quoted) and keywords → preserved
 *
 * This is one-way and lossy; it is NOT a security boundary on its own, but it
 * removes the most common way personal data rides along in query text.
 */
/**
 * Within a comment/string-free plain run, replace standalone numeric literals with
 * `?` while leaving identifiers (incl. those containing digits like `md5`, `int4`,
 * `x1`) untouched.
 */
function maskNumericLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    // Identifier: starts with a letter or underscore; consume the whole token.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) { j++; }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    // Number: a digit not immediately following an identifier char (handled above)
    // or a dot. Consume the whole numeric literal and mask it.
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[0-9.]/.test(text[j]!)) { j++; }
      out += "?";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function redactSqlLiterals(sql: string): string {
  const parts: string[] = [];
  // Plain characters are emitted one-per-token by the scanner; buffer them into a
  // contiguous run so numeric-literal masking sees whole tokens (not single chars).
  let plainBuf = "";
  const flushPlain = () => {
    if (plainBuf) { parts.push(maskNumericLiterals(plainBuf)); plainBuf = ""; }
  };

  let i = 0;
  while (i < sql.length) {
    const token = scanTokenPostgres(sql, i);
    const text = sql.substring(i, token.end);
    switch (token.type) {
      case TokenType.QuotedBlock:
        // String literal or dollar-quoted body → single redacted placeholder.
        flushPlain();
        parts.push("'?'");
        break;
      case TokenType.Comment:
        flushPlain();
        parts.push(" ");
        break;
      case TokenType.QuotedIdentifier:
        // A column/table name — preserved verbatim, never numeric-masked.
        flushPlain();
        parts.push(text);
        break;
      default:
        plainBuf += text;
        break;
    }
    i = token.end;
  }
  flushPlain();
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Split SQL into individual statements, handling semicolons inside quoted contexts (PostgreSQL rules).
 */
export function splitSQLStatements(sql: string): string[] {
  const statements: string[] = [];
  let stmtStart = 0;
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === ";") {
      const trimmed = sql.substring(stmtStart, i).trim();
      if (trimmed.length > 0) { statements.push(trimmed); }
      stmtStart = i + 1;
      i++;
      continue;
    }

    const token = scanTokenPostgres(sql, i);
    i = token.end;
  }

  const trimmed = sql.substring(stmtStart).trim();
  if (trimmed.length > 0) { statements.push(trimmed); }

  return statements;
}
