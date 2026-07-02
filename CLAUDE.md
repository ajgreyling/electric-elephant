# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Electric Elephant Development Guidelines

Electric Elephant is a token-efficient PostgreSQL MCP server implementing the Model Context Protocol (MCP) server interface. It bridges MCP-compatible clients (Claude Desktop, Claude Code, Cursor) with PostgreSQL databases.

## Commands

- Build: `pnpm run build` - Compiles TypeScript to JavaScript using tsup
- Start: `pnpm run start` - Runs the compiled server
- Dev: `pnpm run dev` - Runs server with tsx (no compilation needed)
- Test: `pnpm test` - Run all tests
- Test Watch: `pnpm test:watch` - Run tests in watch mode
- Integration Tests: `pnpm test:integration` - Run database integration tests (requires Docker)

## Architecture Overview

The codebase follows a modular architecture centered around the MCP protocol:

```
src/
├── connectors/          # Database-specific implementations
│   ├── postgres/        # PostgreSQL connector
│   └── ...              # PostgreSQL connector support code
├── tools/               # MCP tool handlers
│   ├── execute-sql.ts   # SQL execution handler
│   ├── search-objects.ts # Unified search/list with progressive disclosure
│   ├── query-insights.ts # pg_stat_statements summaries
│   ├── schema-diff.ts   # Two-source schema comparison
│   ├── diagnose-locks.ts
│   ├── explain-plan.ts
│   ├── observability.ts
│   ├── custom-tool-handler.ts
│   ├── registry.ts
│   └── index.ts
├── utils/               # Shared utilities
│   ├── dsn-obfuscator.ts# DSN security
│   ├── response-formatter.ts # Output formatting
│   ├── allowed-keywords.ts  # Read-only SQL validation
│   ├── pii-heuristics.ts    # Identifier heuristics for PII / clinical columns
│   └── pii-sql-guard.ts     # Pre-execution checks for execute_sql projections
└── index.ts             # Entry point with transport handling
```

Key architectural patterns:
- **Connector Registry**: Dynamic registration system for PostgreSQL connector loading
- **Connector Manager**: Manages PostgreSQL connections (single or multiple sources)
  - Supports multi-source PostgreSQL configuration via TOML
  - Maintains `Map<id, Connector>` for named connections
  - `getConnector(sourceId?)` returns connector by ID or default (first)
  - `getCurrentConnector(sourceId?)` static method for tool handlers
  - Backward compatible with single-connection mode
  - Location: `src/connectors/manager.ts`
- **Transport Abstraction**: Support for both stdio (desktop tools) and HTTP (network clients)
  - HTTP transport endpoint: `/mcp` (aligns with official MCP SDK standard)
  - Implemented in `src/server.ts` using `StreamableHTTPServerTransport` with JSON responses
  - Runs in stateless mode (no SSE support) - GET requests to `/mcp` return 405 Method Not Allowed
  - Tests in `src/__tests__/json-rpc-integration.test.ts`
- **Tool Handlers**: Clean separation of MCP protocol concerns
  - Tools accept optional `source_id` parameter for multi-source PostgreSQL routing
- **PII / clinical column guard (row-returning tools)**: **Hard exclusion (never overridable)** — blocked regardless of `allow_access_to_pii_data` or `clinical_standards`: (a) clinical/health data (HL7v2, FHIR, LOINC, SNOMED, medical heuristics — e.g. `hl7messagecontrolid`, `elzId`, `orderID`, `barcode`, `blood_glucose`, `hiv_status`, `subject_reference`, `loinc_code`, `snomed_ct_code`) → reason `clinical_health_data_blocked`; (b) personal & sensitive data (everything except mobile) — names (bare `name`/`full_name`/etc., but not non-personal `*_name` like `table_name`/`username`), email, government IDs (SSN, tax/VAT, passport, national/identity, driver's licence, voter id), financial (card/IBAN/account/routing/CVV), demographics/special-category (sex, gender, race, ethnicity, religion, nationality, marital status, sexual orientation), DOB/birthday/age, address/location (street, postal/zip, city, province, lat/long, GPS), device/online IDs (IP/MAC, device id, IMEI, biometric, fingerprint), identifying media (photo, avatar, signature), and credentials/secrets (password/hash, api key, tokens, private key, OTP) → reason `hard_pii_blocked`; (c) wildcard projections (`*`, `table.*`) → reason `wildcard_clinical_risk` (can't be statically proven safe). `clinical_standards` is back-compat only and **no longer narrows** detection (all standards always evaluated). **The ONLY overridable field is the user's mobile/phone number** (the Helium username: `mobile`, `mobile_number`, `phone`, `msisdn`, `cellphone`, …). It is blocked by default and permitted only when `allow_access_to_pii_data` is explicitly true (TOML per tool, or single-DSN `--allow-access-to-pii-data` / `ALLOW_ACCESS_TO_PII_DATA` with true/1/yes); reason when blocked: `suspected_pii_or_clinical_column`. All violations return code `PII_ACCESS_VIOLATION`. Applied to `execute_sql` and custom tools (+ custom-tool registration time). Split lives in `src/utils/pii-heuristics.ts` (`findClinicalMatchesInProjectionText` = health; `findHardPiiMatchesInProjectionText` = hard PII; `findPiiMatchesInProjectionText` = overridable mobile only) and `src/utils/pii-sql-guard.ts`, wired from `src/tools/execute-sql.ts`, `src/tools/custom-tool-handler.ts`, `src/tools/registry.ts`.
- **Mandatory target schema**: `execute_sql`, `search_objects`, `explain_plan`, and custom tools require a per-call `schema` argument. SQL is validated for single-schema scope (`SCHEMA_SCOPE_VIOLATION`) before PII or readonly checks; PII and destructive overrides never bypass cross-schema rules. Session `search_path` is pinned with `SET LOCAL` per execution. See `src/utils/sql-schema-scope.ts`.
- **Token-Efficient Schema Exploration**: Unified search/list tool with progressive disclosure
  - `search_objects`: Search objects within a single target schema (required `schema` parameter)
  - Pattern parameter defaults to `%` (match all) - optional for listing use cases
  - Detail levels: `names` (minimal), `summary` (with metadata), `full` (complete structure)
  - Supports: schemas, tables, columns, procedures, indexes
  - Inspired by Anthropic's MCP code execution patterns for reducing token usage
- **Query insights (`query_insights`)**: Surfaces top statements from `pg_stat_statements` (with graceful fallback when the extension is missing or unreadable). See `src/tools/query-insights.ts` and `docs/tools/query-insights.mdx`.
- **Schema drift (`schema_diff`)**: Compares schemas, tables, columns, indexes, and optionally routines between two configured `[[sources]]` ids (`right_source` vs the tool’s bound source). See `src/tools/schema-diff.ts` and `docs/tools/schema-diff.mdx`.
- **Integration Test Base**: Shared test utilities for consistent connector testing

## Configuration

Electric Elephant supports three configuration methods (in priority order):

### 1. TOML Configuration File (PostgreSQL Sources)
**Recommended for projects requiring one or more PostgreSQL connections**

- Create `dbhub.toml` in your project directory or use `--config=path/to/config.toml`
- Configuration structure:
  - `[[sources]]` - Database connection definitions with unique `id` fields
  - `[[tools]]` - Tool configuration (execution settings, custom tools)
- Example:
  ```toml
  [[sources]]
  id = "prod_pg"
  dsn = "postgres://user:pass@localhost:5432/production"
  connection_timeout = 60
  query_timeout = 30

  [[sources]]
  id = "staging_pg"
  dsn = "postgres://user:pass@localhost:5432/staging"

  # Tool configuration (readonly, max_rows, allow_access_to_pii_data are tool-level)
  [[tools]]
  name = "execute_sql"
  source = "prod_pg"
  readonly = true
  max_rows = 1000
  # allow_access_to_pii_data = true  # opt-in only with explicit policy; default blocks sensitive projections
  ```
- Key files:
  - `src/types/config.ts`: TypeScript interfaces for TOML structure
  - `src/config/toml-loader.ts`: TOML parsing and validation
  - `src/config/__tests__/toml-loader.test.ts`: Comprehensive test suite
- Features:
  - Per-source settings: SSH tunnels, timeouts, SSL configuration
  - Default query timeout: **300 seconds** when `query_timeout` is omitted for non-SQLite sources (override in TOML)
  - Per-tool settings: `readonly`, `max_rows`, `allow_access_to_pii_data` (in `[[tools]]`, not `[[sources]]`)
  - Custom tools: Define reusable, parameterized SQL operations
  - Path expansion for `~/` in file paths
  - Automatic password redaction in logs
  - First source is the default database
- Usage in MCP tools: Add optional `source_id` parameter (e.g., `execute_sql(sql, source_id="prod_pg")`)
- See `dbhub.toml.example` for complete configuration reference
- Documentation: https://dbhub.ai/config/toml

### 2. Environment Variables (Single PostgreSQL Database)
- Copy `.env.example` to `.env` and configure for your PostgreSQL connection
- Two ways to configure:
  - Set `DSN` to a full PostgreSQL connection string (recommended)
  - Set individual parameters: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- SSH tunnel via environment: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`

### 3. Command-Line Arguments (Single PostgreSQL Database, Highest Priority)
- **Unknown `--flags` exit with an error** (whitelist `KNOWN_CLI_FLAGS` in `src/config/env.ts`; add new flags there when implementing them).
- `--dsn`: PostgreSQL connection string
- `--schema`: Single-DSN `search_path` (comma-separated schemas), same as TOML `search_path`
- `--transport`: `stdio` (default) or `http` for streamable HTTP transport (endpoint: `/mcp`)
- `--port`: HTTP server port (default: 8080)
- `--auth-token` / `AUTH_TOKEN`: HTTP transport only — require this bearer token on `/mcp` and `/api/*` (unset = disabled). Middleware in `src/utils/auth-middleware.ts`, resolver `resolveAuthToken()` in `src/config/env.ts`.
- `--config`: Path to TOML configuration file
- `--allow-destructive-sql`: Allow INSERT/UPDATE/DELETE etc. (single-DSN mode only; bare flag or `=true` / `1` / `yes`; without this, server defaults to read-only)
- `--allow-access-to-pii-data`: Allow `execute_sql` past the PII/clinical guard (single-DSN only; bare flag or `=true` / `1` / `yes`; TOML `allow_access_to_pii_data` is preferred for multi-source)
- Environment (single-DSN): `ALLOW_ACCESS_TO_PII_DATA` (true/1/yes) — same PII opt-in as CLI when enabling
- `--max-rows`: Limit rows returned from SELECT queries (deprecated - use TOML configuration instead)
- SSH tunnel options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`
- Documentation: https://dbhub.ai/config/command-line

### Configuration Priority Order
1. Command-line arguments (highest)
2. TOML config file (if present)
3. Environment variables
4. `.env` files (`.env.local` in development, `.env` in production)

## PostgreSQL Connector

- Primary connector implementation: `src/connectors/postgres/index.ts`
- Implements the `Connector` and `DSNParser` interfaces from `src/connectors/interface.ts`
- DSN example: `postgres://user:password@localhost:5432/dbname?sslmode=disable`
- SSL modes: `sslmode=disable` (no SSL), `sslmode=require` (SSL without cert verification), `sslmode=verify-ca` (PostgreSQL only, CA verification), `sslmode=verify-full` (PostgreSQL only, CA + hostname verification). Use `sslrootcert` to specify CA certificate path for verify modes.

## Testing Approach

See [TESTING.md](TESTING.md) for comprehensive testing documentation.

For detailed guidance on running and troubleshooting tests, refer to the [testing skill](.claude/skills/testing/SKILL.md). This skill is automatically activated when working with tests, test failures, or Docker/database container issues.

Key points:
- Unit tests for individual components and utilities
- Integration tests using Testcontainers for real PostgreSQL testing
- PostgreSQL connector has comprehensive integration test coverage
- Pre-commit hooks run related tests automatically
- Test PostgreSQL connector: `pnpm test src/connectors/__tests__/postgres.integration.test.ts`
- SSH tunnel tests: `pnpm test postgres-ssh-simple.integration.test.ts`

## SSH Tunnel Support

Electric Elephant supports SSH tunnels for secure database connections through bastion hosts:

- Configuration via command-line options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`
- Configuration via environment variables: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`
- SSH config file support: Automatically reads from `~/.ssh/config` when using host aliases
- Implementation in `src/utils/ssh-tunnel.ts` using the `ssh2` library
- SSH config parsing in `src/utils/ssh-config-parser.ts` using the `ssh-config` library
- Automatic tunnel establishment when SSH config is detected
- Support for both password and key-based authentication
- Default SSH key detection (tries `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc.)
- Tunnel lifecycle managed by `ConnectorManager`

## Code Style

- TypeScript with strict mode enabled
- ES modules with `.js` extension in imports
- Group imports: Node.js core modules → third-party → local modules
- Use camelCase for variables/functions, PascalCase for classes/types
- Include explicit type annotations for function parameters/returns
- Use try/finally blocks with DB connections (always release clients)
- Prefer async/await over callbacks and Promise chains
- Format error messages consistently
- Use parameterized queries for DB operations
- Validate inputs with zod schemas
- Include fallbacks for environment variables
- Use descriptive variable/function names
- Keep functions focused and single-purpose
