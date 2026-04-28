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
id = "unsupported_engine"
type = "mongodb"
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

  it("buildDSNFromSource includes verify-ca and sslrootcert when provided", () => {
    const source: SourceConfig = {
      id: "pg",
      type: "postgres",
      host: "localhost",
      database: "app",
      user: "user",
      password: "pass",
      sslmode: "verify-ca",
      sslrootcert: "/tmp/ca.pem",
    };

    expect(buildDSNFromSource(source)).toBe(
      "postgres://user:pass@localhost:5432/app?sslmode=verify-ca&sslrootcert=%2Ftmp%2Fca.pem"
    );
  });

  it("rejects sslrootcert without verify-ca or verify-full", () => {
    const certPath = path.join(tempDir, "ca.pem");
    fs.writeFileSync(certPath, "test-ca");

    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"
sslmode = "require"
sslrootcert = "${certPath}"
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("sslrootcert requires sslmode 'verify-ca' or 'verify-full'");
  });

  it("rejects missing sslrootcert file", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"
sslmode = "verify-ca"
sslrootcert = "/does/not/exist/ca.pem"
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("sslrootcert file not found or not accessible");
  });

  it("buildDSNFromSource rejects unsupported source type", () => {
    const source = {
      id: "bad",
      type: "mongodb",
      host: "localhost",
      database: "app",
      user: "root",
      password: "secret",
    } as unknown as SourceConfig;

    expect(() => buildDSNFromSource(source)).toThrow(
      "unsupported source type 'mongodb'. PostgreSQL-only mode requires type = \"postgres\"."
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

  it("accepts clinical_standards on execute_sql in [[tools]]", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "execute_sql"
source = "pg"
clinical_standards = ["hl7v2", "fhir", "loinc", "snomed"]
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    const result = loadTomlConfig();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql") as any;
    expect(executeSql?.clinical_standards).toEqual(["hl7v2", "fhir", "loinc", "snomed"]);
  });

  it("rejects clinical_standards on non-execute_sql tools", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "search_objects"
source = "pg"
clinical_standards = ["hl7v2"]
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow(/clinical_standards/);
  });

  it("rejects empty clinical_standards array on execute_sql", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "execute_sql"
source = "pg"
clinical_standards = []
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("invalid clinical_standards");
  });

  it("rejects unknown clinical_standards value on execute_sql", () => {
    const tomlContent = `
[[sources]]
id = "pg"
dsn = "postgres://user:pass@localhost:5432/app"

[[tools]]
name = "execute_sql"
source = "pg"
clinical_standards = ["hl7v2", "openEHR"]
`;
    fs.writeFileSync(path.join(tempDir, "dbhub.toml"), tomlContent);

    expect(() => loadTomlConfig()).toThrow("invalid clinical_standards value");
  });
});
