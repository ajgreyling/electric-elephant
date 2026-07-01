import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as envModule from "../env.js";

const {
  buildDSNFromEnvParams,
  resolveDSN,
  resolveSourceConfigs,
  allowDestructiveSql,
  parseCommandLineArgs,
} = envModule;

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

  it("exits with code 1 when an unknown CLI flag is passed", () => {
    const exitMock = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrMock = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "script.js", "--dsn=postgres://u:p@localhost:5432/db", "--not-a-known-flag"];

    parseCommandLineArgs();

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock.mock.calls.some((c) => String(c[0]).includes("Unknown command-line flag(s)"))).toBe(true);
    exitMock.mockRestore();
    stderrMock.mockRestore();
  });

  it("sets source search_path from --schema in single-DSN mode", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--schema=my_schema",
    ];

    const result = await resolveSourceConfigs();
    expect(result?.sources[0]?.search_path).toBe("my_schema");
  });

  it("rejects comma-separated --schema values in single-DSN mode", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--schema=my_schema,public",
    ];

    await expect(resolveSourceConfigs()).rejects.toThrow(/single schema name is allowed/);
  });

  it("sets execute_sql readonly=false with bare --allow-destructive-sql in single-DSN mode", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-destructive-sql",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ readonly: false });
  });

  it("keeps execute_sql readonly when --allow-destructive-sql= (empty value)", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-destructive-sql=",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ readonly: true });
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

  it("sets allow_access_to_pii_data with bare --allow-access-to-pii-data", async () => {
    process.argv = ["node", "script.js", "--dsn=postgres://u:p@localhost:5432/db", "--allow-access-to-pii-data"];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("sets allow_access_to_pii_data with --allow-access-to-pii-data=1", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=1",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(executeSql).toMatchObject({ allow_access_to_pii_data: true });
  });

  it("does not enable PII access for --allow-access-to-pii-data= (empty value)", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(
      executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined
    ).toBeUndefined();
  });

  it("does not enable PII access when --allow-access-to-pii-data=false", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data=false",
    ];

    const result = await resolveSourceConfigs();
    const executeSql = result?.tools?.find((t) => t.name === "execute_sql");
    expect(
      executeSql && "allow_access_to_pii_data" in executeSql ? executeSql.allow_access_to_pii_data : undefined
    ).toBeUndefined();
  });

  it("enables PII access via --allow-access-to-pii-data when ALLOW_ACCESS_TO_PII_DATA is false", async () => {
    process.argv = [
      "node",
      "script.js",
      "--dsn=postgres://u:p@localhost:5432/db",
      "--allow-access-to-pii-data",
    ];
    process.env.ALLOW_ACCESS_TO_PII_DATA = "false";

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

    it("returns true for bare --allow-access-to-pii-data", () => {
      process.argv = ["node", "script.js", "--allow-access-to-pii-data"];
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(true);
    });

    it("returns false for --allow-access-to-pii-data=0", () => {
      process.argv = ["node", "script.js", "--allow-access-to-pii-data=0"];
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(false);
    });

    it("returns false for --allow-access-to-pii-data= (empty)", () => {
      process.argv = ["node", "script.js", "--allow-access-to-pii-data="];
      expect(envModule.allowAccessToPiiDataFromEnvCli()).toBe(false);
    });
  });

  describe("allowDestructiveSql", () => {
    it("enables destructive SQL for bare --allow-destructive-sql", () => {
      process.argv = ["node", "script.js", "--allow-destructive-sql"];
      expect(allowDestructiveSql()).toBe(true);
    });

    it("enables destructive SQL for --allow-destructive-sql=yes", () => {
      process.argv = ["node", "script.js", "--allow-destructive-sql=yes"];
      expect(allowDestructiveSql()).toBe(true);
    });

    it("enables destructive SQL for --allow-destructive-sql=1", () => {
      process.argv = ["node", "script.js", "--allow-destructive-sql=1"];
      expect(allowDestructiveSql()).toBe(true);
    });

    it("keeps destructive SQL disabled for --allow-destructive-sql= (empty)", () => {
      process.argv = ["node", "script.js", "--allow-destructive-sql="];
      expect(allowDestructiveSql()).toBe(false);
    });

    it("keeps destructive SQL disabled for --allow-destructive-sql=false", () => {
      process.argv = ["node", "script.js", "--allow-destructive-sql=false"];
      expect(allowDestructiveSql()).toBe(false);
    });

    it("keeps destructive SQL disabled when flag is absent", () => {
      process.argv = ["node", "script.js"];
      expect(allowDestructiveSql()).toBe(false);
    });
  });
});
