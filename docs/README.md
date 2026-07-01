# Electric Elephant Documentation

<p align="center">
  <img src="../assets/elelctric-elephant-logo.png" alt="Electric Elephant MCP — robotic elephant logo with glowing cyan accents on black" width="420" />
</p>

User-facing docs for **Electric Elephant**, an MCP server for **PostgreSQL only**. It does not target other SQL databases or generic ODBC/JDBC clients.

Electric Elephant **hard-excludes** **clinical/health data** (HL7v2, FHIR, LOINC, SNOMED, medical fields) and **personal identifiers** (names, email, national IDs, DOB, address), plus wildcard projections, on `execute_sql` and custom tools: fail-closed, name-based heuristics run before execution and cannot be overridden — the **only** field `allow_access_to_pii_data` unblocks is the user's mobile/phone number. Every row-returning tool is also confined to a single required `schema`. These are heuristics (best-effort, not a guarantee)—use them alongside proper access control, policy, and review.

`execute_sql` documentation covers that guard in detail, including HL7/LIS-style clinical field projections (for example message control IDs and result payload columns), which are **hard-excluded** and can never be returned. **The guard cannot be disabled.** `allow_access_to_pii_data` unblocks **only** the user's mobile/phone number (the Helium username) — health data, other personal identifiers, and wildcards stay blocked. Set `allow_access_to_pii_data = true` on the `[[tools]]` entry for `execute_sql` in TOML (recommended for multi-source); in **single-DSN** mode use env `ALLOW_ACCESS_TO_PII_DATA` (true/1/yes), or CLI **bare** `--allow-access-to-pii-data` (or `=true` / `1` / `yes`—see [Command line — PII guard](config/command-line.mdx#pii-guard-cli)). The `clinical_standards` field is retained for backward compatibility but **no longer narrows** detection — all standards are always evaluated. For controlled staging/preprod workflows that require data fixes, opt into write operations in single-DSN mode with **bare** `--allow-destructive-sql` or `=true` / `1` / `yes` ([destructive SQL CLI](config/command-line.mdx#destructive-sql-cli)).

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
