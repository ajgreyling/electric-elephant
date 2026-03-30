import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadTomlConfig, buildDSNFromSource } from "../toml-loader.js";
import type { SourceConfig } from "../../types/config.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("TOML Configuration Tests (PostgreSQL-only)", () => {
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbhub-test-"));
    process.chdir(tempDir);
    process.argv = ["node", "test"];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.argv = originalArgv;
  });

  it("loads a postgres source from dbhub.toml", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    const result = loadTomlConfig();
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]).toMatchObject({
      id: "pg",
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "user",
    });
  });

  it("rejects non-postgres source types", () => {
    const tomlContent = `
[[sources]]
id = "mysql"
type = "mysql"
host = "localhost"
database = "app"
user = "root"
password = "secret"
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("must have either");
  });

  it("buildDSNFromSource builds postgres DSN from params", () => {
    const source: SourceConfig = {
      id: "pg",
      type: "postgres",
      host: "localhost",
      database: "app",
      user: "user",
      password: "pass",
    };

    expect(buildDSNFromSource(source)).toBe("postgres://user:pass@localhost:5432/app");
  });

  it("buildDSNFromSource rejects unsupported source type", () => {
    const source: SourceConfig = {
      id: "bad",
      type: "mysql" as SourceConfig["type"],
      host: "localhost",
      database: "app",
      user: "root",
      password: "secret",
    };

    expect(() => buildDSNFromSource(source)).toThrow(
      "unsupported source type 'mysql'. PostgreSQL-only mode requires type = \"postgres\"."
    );
  });

  it("accepts allow_access_to_pii_data on execute_sql in [[tools]]", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "execute_sql"
source = "pg"
allow_access_to_pii_data = true
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    const result = loadTomlConfig();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("rejects allow_access_to_pii_data on non-execute_sql tools", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "search_objects"
source = "pg"
allow_access_to_pii_data = true
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow(/allow_access_to_pii_data/);
  });

  it("rejects non-boolean allow_access_to_pii_data on execute_sql", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "execute_sql"
source = "pg"
allow_access_to_pii_data = "yes"
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("invalid allow_access_to_pii_data");
  });
});
