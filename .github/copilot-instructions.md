## Database Access

This project provides an MCP server (Electric Elephant) for secure SQL access to the development database.

**PII / clinical guard:** Unless the server is configured with `allow_access_to_pii_data=true` (TOML `[[tools]]`, or single-DSN `ALLOW_ACCESS_TO_PII_DATA` / `--allow-access-to-pii-data=true`), `execute_sql` rejects wildcard projections (`SELECT *`, `table.*`) and columns/expressions that match sensitive heuristics. Prefer explicit column lists. Blocked queries return `PII_ACCESS_VIOLATION`. See `docs/tools/execute-sql.mdx`.

AI agents can execute SQL queries. In read-only mode (recommended for production):

- `SELECT id, status FROM users LIMIT 5;` (explicit columns — avoid `SELECT *` when the guard is enabled)
- `SHOW TABLES;`
- `DESCRIBE table_name;`

In read-write mode (development/testing):

- `INSERT INTO users (name, email) VALUES ('John', 'john@example.com');`
- `UPDATE users SET status = 'active' WHERE id = 1;`
- `CREATE TABLE test_table (id INT PRIMARY KEY);`

Configure read-only and tool limits in TOML (`[[tools]]` for `execute_sql`); legacy `--readonly` is not used for Electric Elephant — see project docs.
