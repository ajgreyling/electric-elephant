# Electric Elephant Documentation

<p align="center">
  <img src="../assets/elelctric-elephant-logo.png" alt="Electric Elephant MCP — robotic elephant logo with glowing cyan accents on black" width="420" />
</p>

User-facing docs for **Electric Elephant**, an MCP server for **PostgreSQL only**. It does not target other SQL databases or generic ODBC/JDBC clients.

Electric Elephant **attempts to mitigate** exposure of **PII** and **clinical or sensitive health-related data** by default on `execute_sql`: fail-closed, name-based heuristics run before execution. This reduces accidental broad or sensitive projections but is **not a guarantee**—use it alongside proper access control, policy, and review.

`execute_sql` documentation covers that guard in detail, including HL7/LIS-style clinical field projections (for example message control IDs and result payload columns) that are blocked by default unless policy explicitly allows bypassing it. **Ways to disable the guard (same effect as `allow_access_to_pii_data`):** set `allow_access_to_pii_data = true` on the `[[tools]]` entry for `execute_sql` in TOML (recommended for multi-source); in **single-DSN** mode use env `ALLOW_ACCESS_TO_PII_DATA` (true/1/yes), or CLI **bare** `--allow-access-to-pii-data` (or `=true` / `1` / `yes`—see [Command line — PII guard](config/command-line.mdx#pii-guard-cli)). The guard supports optional standards-aware profiles via `clinical_standards = ["hl7v2","fhir","loinc","snomed"]` (default: all enabled). For controlled staging/preprod workflows that require data fixes, opt into write operations in single-DSN mode with **bare** `--allow-destructive-sql` or `=true` / `1` / `yes` ([destructive SQL CLI](config/command-line.mdx#destructive-sql-cli)).

Install the [Mintlify CLI](https://www.npmjs.com/package/mint) to preview documentation locally:

```bash
npm i -g mint
```

Run the following command at the root of your documentation (where `docs.json` is located):

```bash
cd docs
mint dev
```

## Documentation map

| Area | Location |
|------|----------|
| MCP tools overview (built-ins, naming, TOML) | [`tools/overview.mdx`](tools/overview.mdx) |
| `execute_sql` (PII/clinical mitigation, read-only) | [`tools/execute-sql.mdx`](tools/execute-sql.mdx) |
| `search_objects` | [`tools/search-objects.mdx`](tools/search-objects.mdx) |
| `query_insights` | [`tools/query-insights.mdx`](tools/query-insights.mdx) |
| `schema_diff` | [`tools/schema-diff.mdx`](tools/schema-diff.mdx) |
| Custom `[[tools]]` SQL | [`tools/custom-tools.mdx`](tools/custom-tools.mdx) |
| CLI & env | [`config/command-line.mdx`](config/command-line.mdx) |
| `dbhub.toml` | [`config/toml.mdx`](config/toml.mdx) |
| Navigation / site structure | [`docs.json`](docs.json) |
