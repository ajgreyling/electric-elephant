---
name: electric-elephant
description: Guide for querying databases through Electric Elephant server. Use this skill whenever you need to explore database schemas, inspect tables, run SQL, tune queries, or compare two Postgres sources via MCP tools (search_objects, execute_sql, query_insights, schema_diff, explain_plan, and other built-ins). Activates on database query tasks, schema exploration, performance hints, drift checks, data retrieval, or SQL execution through MCP.
---

# Electric Elephant Database Query Guide

When working with databases through Electric Elephant's MCP server, always follow the **explore-then-query** pattern. Jumping straight to SQL without understanding the schema is the most common mistake — it leads to failed queries, wasted tokens, and frustrated users.

## Available Tools

Electric Elephant registers **built-in** tools per configured PostgreSQL source (default: all enabled; narrow with explicit `[[tools]]` in TOML). Common tools:

| Tool | Purpose |
|------|---------|
| `search_objects` | Explore schemas, tables, columns, indexes, procedures, functions (progressive detail) |
| `execute_sql` | Run SQL (multi-statement); optional PII/clinical column **fail-closed** guard |
| `query_insights` | Top statements from `pg_stat_statements` when the extension is available |
| `schema_diff` | Compare schema metadata between this source and another (`right_source` argument; needs ≥2 sources in config) |
| `explain_plan` | Structured `EXPLAIN` for one read-only statement |
| `diagnose_locks` | Lock blockers / waiting sessions |
| `replication_status` | Replication / slots |
| `table_health` | Dead tuples, vacuum/analyze, sizes |
| `extensions_status` | Extensions + `pg_stat_statements` readiness |

**Custom tools** — parameterized SQL snippets in `dbhub.toml` — appear as additional tool names.

If multiple PostgreSQL sources are configured, tool names are suffixed with the source id (for example, `search_objects_prod_pg`, `execute_sql_staging_pg`). Select the desired source by calling the matching tool name.

### PII and clinical column guard (`execute_sql`)

By default, `execute_sql` uses a **fail-closed** guard: it can reject queries that use `SELECT *` / `table.*` or that list columns or aliases matching PII or sensitive clinical heuristics. Guard matching is standards-aware via optional per-tool config `clinical_standards = ["hl7v2","fhir","loinc","snomed"]` (default: all enabled), covering HL7/LIS plus FHIR/LOINC/SNOMED naming styles. The tool response uses code **`PII_ACCESS_VIOLATION`** with a reason such as `wildcard_projection` or `suspected_pii_or_clinical_column`.

**Agent behavior:**

- Prefer **explicit column lists** after inspecting columns with `search_objects` — do not rely on `SELECT *`.
- If you hit `PII_ACCESS_VIOLATION`, narrow the projection to non-sensitive columns or ask the user to enable `allow_access_to_pii_data` in TOML (or single-DSN env/CLI) only if their policy allows it.
- Full details: project `docs/tools/execute-sql.mdx` (PII and clinical data guard).

## The Explore-Then-Query Workflow

Every database task should follow this progression. The key insight is that each step narrows your focus, so you never waste tokens loading information you don't need.

### Step 1: Discover what schemas exist

```
search_objects(object_type="schema", detail_level="names")
```

This tells you the lay of the land. Most PostgreSQL databases use `public` as the primary schema, plus system schemas you can ignore.

### Step 2: Find relevant tables

Once you know the schema, list its tables:

```
search_objects(object_type="table", schema="public", detail_level="names")
```

If you're looking for something specific, use a pattern:

```
search_objects(object_type="table", schema="public", pattern="%user%", detail_level="names")
```

The `pattern` parameter uses SQL LIKE syntax: `%` matches any characters, `_` matches a single character.

If you need more context to identify the right table (row counts, column counts, table comments), use `detail_level="summary"` instead.

### Step 3: Inspect table structure

Before writing any query, understand the columns:

```
search_objects(object_type="column", schema="public", table="users", detail_level="full")
```

This returns column names, data types, nullability, and defaults — everything you need to write correct SQL.

For understanding query performance or join patterns, also check indexes:

```
search_objects(object_type="index", schema="public", table="users", detail_level="full")
```

### Step 4: Write and execute the query

Now that you know the exact table and column names, write precise SQL:

```
execute_sql(sql="SELECT id, email, created_at FROM public.users WHERE created_at > '2024-01-01' ORDER BY created_at DESC")
```

## Progressive Disclosure: Choosing the Right Detail Level

The `detail_level` parameter controls how much information `search_objects` returns. Start minimal and drill down only where needed — this keeps responses fast and token-efficient.

| Level | What you get | When to use |
|-------|-------------|-------------|
| `names` | Just object names | Browsing, finding the right table |
| `summary` | Names + metadata (row count, column count, comments) | Choosing between similar tables, understanding data volume |
| `full` | Complete structure (columns with types, indexes, procedure definitions) | Before writing queries, understanding relationships |

**Rule of thumb:** Use `names` for broad exploration, `summary` for narrowing down, and `full` only for the specific tables you'll query.

## Working with Multiple PostgreSQL Sources

When Electric Elephant is configured with multiple PostgreSQL sources, it registers separate tool instances for each source. The tool names follow the pattern `{tool}_{source_id}`:

```
# Query the production PostgreSQL database
search_objects_prod_pg(object_type="table", schema="public", detail_level="names")
execute_sql_prod_pg(sql="SELECT count(*) FROM orders")

# Query the staging PostgreSQL database
search_objects_staging_pg(object_type="table", schema="public", detail_level="names")
execute_sql_staging_pg(sql="SELECT count(*) FROM public.orders")
```

In single-source setups, built-in tools have no id suffix (for example `search_objects`, `execute_sql`). When the user mentions a specific PostgreSQL environment, call the correspondingly suffixed tool.

**Performance / drift:** Use `query_insights` (after confirming `pg_stat_statements` via `extensions_status`) to spot hot queries, then `explain_plan` on a representative read-only statement. Use `schema_diff` from one configured source with `right_source` set to the peer id when comparing staging vs production schema metadata.

## Searching for Specific Objects

The `search_objects` tool supports targeted searches across all object types:

```
# Find all tables with "order" in the name
search_objects(object_type="table", pattern="%order%", detail_level="names")

# Find columns named "email" across all tables
search_objects(object_type="column", pattern="email", detail_level="names")

# Find stored procedures matching a pattern
search_objects(object_type="procedure", schema="public", pattern="%report%", detail_level="summary")

# Find functions
search_objects(object_type="function", schema="public", detail_level="names")
```

## Common Patterns

### "What data do we have?"
1. List schemas → list tables with `summary` detail → pick relevant tables → inspect with `full` detail

### "Get me X from the database"
1. Search for tables related to X → inspect columns → write targeted SELECT

### "How are these tables related?"
1. Inspect both tables at `full` detail (columns + indexes reveal foreign keys and join columns)

### "Run this specific SQL"
If the user provides exact SQL, you can execute it directly. But if it fails with a column or table error, fall back to the explore workflow rather than guessing fixes.

## Error Recovery

When a query fails:
- **Unknown table/column**: Use `search_objects` to find the correct names rather than guessing variations
- **Schema errors**: List available schemas first — the table may be in a different schema than expected
- **`PII_ACCESS_VIOLATION`**: Wildcard or sensitive-looking projection blocked; use explicit safe columns or policy-approved `allow_access_to_pii_data`
- **Permission errors**: The database may be in read-only mode; check if only SELECT statements are allowed
- **Multiple statements**: `execute_sql` supports multiple SQL statements separated by `;`

## What NOT to Do

- **Don't guess table or column names.** Always verify with `search_objects` first. A wrong guess wastes a round trip and confuses the conversation.
- **Don't dump entire schemas upfront.** Use progressive disclosure — start with `names`, drill into `full` only for tables you'll actually query.
- **Don't use the wrong tool in multi-source setups.** If the user mentions a specific PostgreSQL environment, call the source-specific tool variant (e.g., `execute_sql_prod_pg`) rather than the generic `execute_sql`.
- **Don't retry failed queries blindly.** If SQL fails, investigate the schema to understand why before retrying.
