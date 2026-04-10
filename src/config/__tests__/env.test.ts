import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as envModule from "../env.js";

const { buildDSNFromEnvParams, resolveDSN, resolveSourceConfigs } = envModule;

vi.mock("../toml-loader.js", () => ({
  loadTomlConfig: vi.fn(() => null),
}));

describe("Environment Configuration Tests (PostgreSQL-only)", () => {
  const originalEnv = { ...process.env };
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = ["node", "script.js"];
    delete process.env.DB_TYPE;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DB_NAME;
    delete process.env.DSN;
    delete process.env.ALLOW_ACCESS_TO_PII_DATA;
    vi.spyOn(envModule, "loadEnvFiles").mockReturnValue(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("builds a postgres DSN from env parameters", () => {
    process.env.DB_TYPE = "postgres";
    process.env.DB_HOST = "localhost";
    process.env.DB_USER = "user";
    process.env.DB_PASSWORD = "pass";
    process.env.DB_NAME = "db";

    expect(buildDSNFromEnvParams()).toEqual({
      dsn: "postgres://user:pass@localhost:5432/db",
      source: "individual environment variables",
    });
  });

  it("supports postgresql alias", () => {
    process.env.DB_TYPE = "postgresql";
    process.env.DB_HOST = "localhost";
    process.env.DB_USER = "user";
    process.env.DB_PASSWORD = "pass";
    process.env.DB_NAME = "db";

    expect(buildDSNFromEnvParams()?.dsn).toBe("postgres://user:pass@localhost:5432/db");
  });

  it("rejects non-postgres DB_TYPE values", () => {
    process.env.DB_TYPE = "mongodb";
    process.env.DB_HOST = "localhost";
    process.env.DB_USER = "user";
    process.env.DB_PASSWORD = "pass";
    process.env.DB_NAME = "db";

    expect(() => buildDSNFromEnvParams()).toThrow(
      "Unsupported DB_TYPE: mongodb. Supported types: postgres, postgresql"
    );
  });

  it("resolves DSN from DSN env var before individual params", () => {
    process.env.DSN = "postgres://direct:dsn@localhost:5432/directdb";
    process.env.DB_TYPE = "postgres";
    process.env.DB_HOST = "localhost";
    process.env.DB_USER = "user";
    process.env.DB_PASSWORD = "pass";
    process.env.DB_NAME = "db";

    expect(resolveDSN()).toEqual({
      dsn: "postgres://direct:dsn@localhost:5432/directdb",
      source: "environment variable",
    });
  });

  it("rejects non-postgres DSN in resolveSourceConfigs", async () => {
    process.argv = ["node", "script.js", "--dsn=redis://localhost:6379/0"];

    await expect(resolveSourceConfigs()).rejects.toThrow(
      "PostgreSQL-only mode supports postgres/postgresql DSNs only"
    );
  });

  it("omits allow_access_to_pii_data on execute_sql by default in single-DSN mode", async () => {
    process.argv = ["node", "script.js", "--dsn=postgres://u:p@localhost:5432/db"];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined).toBeUndefined();
  });

  it("sets allow_access_to_pii_data when ALLOW_ACCESS_TO_PII_DATA is true", async () => {
    process.env.DSN = "postgres://u:p@localhost:5432/db";
    process.env.ALLOW_ACCESS_TO_PII_DATA = "true";

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("sets allow_access_to_pii_data with --allow-access-to-pii-data=true (CLI overrides env)", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=true",
    ];
    process.env.ALLOW_ACCESS_TO_PII_DATA = "false";

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("does not enable PII access for bare --allow-access-to-pii-data", async () => {
    process.argv = ["node", "script.js", "--dsn=postgres://u:p@localhost:5432/db", "--allow-access-to-pii-data"];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(
      executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined
    ).toBeUndefined();
  });

  it("sets allow_access_to_pii_data with bare --disable-pii-guard (debug)", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("sets allow_access_to_pii_data with --disable-pii-guard=true", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard=true",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("does not enable PII access when --disable-pii-guard=false", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard=false",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(
      executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined
    ).toBeUndefined();
  });

  it("prefers explicit --allow-access-to-pii-data=false over --disable-pii-guard", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=false",
      "--disable-pii-guard",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(
      executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined
    ).toBeUndefined();
  });

  it("sets allow_access_to_pii_data with --disable-pii-guard=1", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard=1",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("sets allow_access_to_pii_data with --disable-pii-guard=yes (case-insensitive)", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard=YES",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("sets allow_access_to_pii_data when --disable-pii-guard is followed by yes as separate argv token", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard",
      "yes",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("enables PII access via --disable-pii-guard when ALLOW_ACCESS_TO_PII_DATA is false", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--disable-pii-guard",
    ];
    process.env.ALLOW_ACCESS_TO_PII_DATA = "false";

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("keeps PII access on when --allow-access-to-pii-data=true despite --disable-pii-guard=false", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=true",
      "--disable-pii-guard=false",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  describe("allowAccessToPiiDataFromEnvCli", () => {
    it("returns false when no CLI flag and no env", () => {
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(false);
    });

    it("returns true for env ALLOW_ACCESS_TO_PII_DATA=yes", () => {
      process.env.ALLOW_ACCESS_TO_PII_DATA = "yes";
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(true);
    });

    it("returns true for bare --disable-pii-guard", () => {
      process.argv = ["node", "script.js", "--disable-pii-guard"];
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(true);
    });

    it("returns false for --disable-pii-guard=0", () => {
      process.argv = ["node", "script.js", "--disable-pii-guard=0"];
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(false);
    });
  });
});
