# Electric Elephant Documentation

<p align="center">
  <img src="../assets/elelctric-elephant-logo.png" alt="Electric Elephant MCP — robotic elephant logo with glowing cyan accents on black" width="420" />
</p>

User-facing docs for **Electric Elephant**, an MCP server for **PostgreSQL only**. It does not target other SQL databases or generic ODBC/JDBC clients.

`execute_sql` documentation also covers the fail-closed PII/clinical guard, including HL7/LIS-style clinical field projections (for example message control IDs and result payload columns) that are blocked by default unless policy explicitly allows bypassing it. **Ways to disable the guard (same effect as `allow_access_to_pii_data`):** set `allow_access_to_pii_data = true` on the `[[tools]]` entry for `execute_sql` in TOML (recommended for multi-source); in **single-DSN** mode use env `ALLOW_ACCESS_TO_PII_DATA` (true/1/yes), CLI `--allow-access-to-pii-data=true`, or the debugging shortcut **`--disable-pii-guard`** (bare flag or `=true` / `1` / `yes`—see [Command line — PII guard](config/command-line.mdx#pii-guard-cli)). If both `--allow-access-to-pii-data` and `--disable-pii-guard` are present, the former takes precedence. The guard supports optional standards-aware profiles via `clinical_standards = ["hl7v2","fhir","loinc","snomed"]` (default: all enabled).

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
| `execute_sql` (PII guard, read-only) | [`tools/execute-sql.mdx`](tools/execute-sql.mdx) |
| `search_objects` | [`tools/search-objects.mdx`](tools/search-objects.mdx) |
| `query_insights` | [`tools/query-insights.mdx`](tools/query-insights.mdx) |
| `schema_diff` | [`tools/schema-diff.mdx`](tools/schema-diff.mdx) |
| Custom `[[tools]]` SQL | [`tools/custom-tools.mdx`](tools/custom-tools.mdx) |
| CLI & env | [`config/command-line.mdx`](config/command-line.mdx) |
| `dbhub.toml` | [`config/toml.mdx`](config/toml.mdx) |
| Navigation / site structure | [`docs.json`](docs.json) |
