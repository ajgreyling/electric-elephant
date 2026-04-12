# Electric Elephant

<p align="center">
  <img src="assets/elelctric-elephant-logo.png" alt="Electric Elephant MCP — robotic elephant logo with glowing cyan accents on black" width="420" />
</p>

Electric Elephant is a token-efficient MCP server for exploring and querying **PostgreSQL** from MCP-capable clients. It is **not** a generic SQL bridge: only PostgreSQL is supported (not MySQL, SQLite, SQL Server, Oracle, or other engines).

**PII and clinical data:** The server **attempts to mitigate** accidental exposure of personally identifiable information and sensitive clinical-style fields through `execute_sql` (heuristic, fail-closed checks on projections before queries run). That is a **best-effort safeguard**, not certification or a substitute for database permissions, row-level security, legal review, or your own data policies. See the Purpose bullet and [`docs/tools/execute-sql.mdx`](docs/tools/execute-sql.mdx).

Repository: [github.com/ajgreyling/electric-elephant](https://github.com/ajgreyling/electric-elephant)

## Upstream Sync Status

Electric Elephant is a fork of dbhub. PostgreSQL-relevant upstream fixes are synced through dbhub commit `30d8007998503defc05d5198bcbd9130c609ee41` (2026-04-07), on top of upstream release line `v0.21.2`.

Backported upstream commits:
- `f319114033279532aff2ce9aaef2ce84b127a21f` (PostgreSQL `getTableComment()` view support)
- `ce2621d83d78d9ab8b363664c955584cb59ee049` (graceful skip on transitive `MODULE_NOT_FOUND`)
- `30d8007998503defc05d5198bcbd9130c609ee41` (HTTP DNS rebinding protection)

## Purpose

- Expose PostgreSQL through MCP tools (`execute_sql`, `search_objects`, `query_insights`, `schema_diff`, observability helpers, and related wiring).
- PostgreSQL-only: no connectors or compatibility layers for other SQL databases.
- Provide safe defaults (read-only unless explicitly enabled for destructive SQL).
- **Mitigate PII / clinical leakage (best effort):** heuristic guard on `execute_sql` blocks wildcard projections and many sensitive-looking column names unless explicitly opted in (name-based heuristics can false positive or false negative). Opt-in: TOML `allow_access_to_pii_data`, env `ALLOW_ACCESS_TO_PII_DATA`, or single-DSN CLI **bare** `--allow-access-to-pii-data` (or `=true` / `1` / `yes`). **Destructive SQL** in single-DSN mode: same pattern with **`--allow-destructive-sql`**. Clinical naming profiles include HL7v2/FHIR/LOINC/SNOMED-style identifiers. See `docs/tools/execute-sql.mdx`, `docs/config/command-line.mdx`, and `CLAUDE.md`.

## Repository Landmarks

- `src/index.ts` - entrypoint and startup path.
- `src/server.ts` - HTTP MCP transport wiring.
- `src/connectors/` - database connector implementations.
- `src/tools/` - MCP tool handlers (`execute_sql`, `search_objects`, `query_insights`, `schema_diff`, etc.).
- `src/config/` - TOML/config loading and validation.
- `frontend/` - local web workbench UI.
- `CLAUDE.md` - architecture and development conventions.

## Installation

For end users running Electric Elephant as an MCP server:

**NPM (`npx`):**

```bash
npx electric-elephant --transport http --port 8080 --dsn "postgres://postgres:postgres@localhost:5432/postgres"
```

**Docker:**

```bash
docker run --rm --init \
  --name electric-elephant \
  --publish 8080:8080 \
  electric-elephant \
  --transport http \
  --port 8080 \
  --dsn "postgres://postgres:postgres@host.docker.internal:5432/postgres"
```

See [`docs/installation.mdx`](docs/installation.mdx) and [`docs/quickstart.mdx`](docs/quickstart.mdx) for full client setup instructions.

## Development Quick Start

```bash
pnpm install
pnpm run dev
```

Build and test:

```bash
pnpm run build
pnpm test
```

## Workbench

Electric Elephant includes a built-in web Workbench for running tools and inspecting request traces.

- Start server with HTTP transport (examples above), then open `http://localhost:8080`
- Workbench UI: `/`
- MCP endpoint: `/mcp`

More details: [`docs/workbench/overview.mdx`](docs/workbench/overview.mdx)

## MCP Request Flow

```mermaid
flowchart LR
    A[MCP Client] --> B[Transport: stdio or HTTP]
    B --> C[Tool Router]
    C --> D{Tool}
    D -->|execute_sql search_objects query_insights schema_diff ...| E[Connector Manager]
    E --> F[PostgreSQL connector]
    F --> G[(PostgreSQL)]
    G --> F --> E --> C --> A
```

All built-ins (including read-only diagnostics such as `explain_plan`, `diagnose_locks`, and `replication_status`) route through the connector manager to the same PostgreSQL connection pool for the selected source.

## Built-in MCP tools

These tools are enabled by default per `[[sources]]` entry unless you whitelist a subset with `[[tools]]` in `dbhub.toml`. With multiple sources, names are suffixed with the source id (for example `execute_sql_prod_pg`).

| Tool | Role |
|------|------|
| `execute_sql` | Run SQL (multi-statement supported); **attempts to mitigate** PII/clinical exposure via default guard (opt out via TOML/env/CLI `--allow-access-to-pii-data` in single-DSN mode); standards-aware profiles (`hl7v2`, `fhir`, `loinc`, `snomed`) |
| `search_objects` | Discover schemas, tables, columns, indexes, routines (progressive detail) |
| `query_insights` | Ranked statements from `pg_stat_statements` when available |
| `schema_diff` | Compare schema metadata between two configured sources |
| `explain_plan` | Structured `EXPLAIN (FORMAT JSON, …)` for one read-only statement |
| `diagnose_locks` | Blocking / waiting sessions from `pg_stat_activity` |
| `replication_status` | Replication lag, streaming clients, slots |
| `table_health` | Dead tuples, vacuum/analyze stats, relation sizes |
| `extensions_status` | Installed extensions and `pg_stat_statements` readiness |

User-defined **`[[tools]]`** entries add custom parameterized SQL tools. See `docs/tools/overview.mdx` and `dbhub.toml.example`.

## Query Execution State Machine

```mermaid
stateDiagram-v2
    [*] --> RequestReceived
    RequestReceived --> ValidatingInput
    ValidatingInput --> SelectingSource
    SelectingSource --> Executing
    Executing --> FormattingResponse
    FormattingResponse --> Completed
    Executing --> Failed
    ValidatingInput --> Failed
    Failed --> [*]
    Completed --> [*]
```

## Human + AI Agent Onboarding Checklist

1. Read `CLAUDE.md` before editing connectors/tools.
2. Prefer tool-level changes in `src/tools/` over transport-layer changes.
3. Keep `source_id` routing behavior backward compatible.
4. When changing `execute_sql`, preserve PII guard semantics (`pii-sql-guard.ts`, `pii-heuristics.ts`, `PII_ACCESS_VIOLATION`).
5. Run relevant tests (`pnpm test`, or targeted connector/integration tests).

## Tool Schema Examples

`execute_sql` input (list explicit columns; `SELECT *` may be rejected while the PII guard is active—disable only with explicit policy: TOML, `ALLOW_ACCESS_TO_PII_DATA`, or bare `--allow-access-to-pii-data`):

```json
{
  "sql": "SELECT id, status FROM users LIMIT 10;"
}
```

`search_objects` input:

```json
{
  "object_type": "column",
  "schema": "public",
  "table": "users",
  "pattern": "%_id",
  "detail_level": "summary",
  "limit": 50
}
```

## Related Docs

- [`docs/tools/overview.mdx`](docs/tools/overview.mdx) — all MCP tools and TOML whitelisting.
- [`docs/tools/execute-sql.mdx`](docs/tools/execute-sql.mdx) — `execute_sql`, read-only mode, PII guard.
- [`docs/config/command-line.mdx`](docs/config/command-line.mdx) — CLI flags including `--allow-access-to-pii-data` (single-DSN).
- [`docs/tools/search-objects.mdx`](docs/tools/search-objects.mdx) — `search_objects` patterns and detail levels.
- [`docs/tools/query-insights.mdx`](docs/tools/query-insights.mdx) — `query_insights` and `pg_stat_statements`.
- [`docs/tools/schema-diff.mdx`](docs/tools/schema-diff.mdx) — `schema_diff` between two sources.
- [`docs/tools/custom-tools.mdx`](docs/tools/custom-tools.mdx) — parameterized custom tools.
- [`dbhub.toml.example`](dbhub.toml.example) — multi-source and tool configuration examples.
- Mintlify site config: [`docs/docs.json`](docs/docs.json).

