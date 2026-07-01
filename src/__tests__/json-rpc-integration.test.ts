import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("JSON RPC Integration Tests", () => {
  let serverProcess: ChildProcess | null = null;
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  const testPort = 3001;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine")
      .withDatabase("jsonrpctest")
      .withUsername("testuser")
      .withPassword("testpass")
      .start();

    const dsn = container.getConnectionUri();
    baseUrl = `http://localhost:${testPort}`;

    const projectRoot = path.resolve(import.meta.dirname, "..", "..");

    serverProcess = spawn(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/index.ts",
        "--transport=http",
        `--port=${testPort}`,
        `--dsn=${dsn}`,
        "--allow-destructive-sql=true",
        "--allow-access-to-pii-data=true",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          TRANSPORT: "http",
          NODE_ENV: "test",
        },
        stdio: "pipe",
      }
    );

    let serverReady = false;
    for (let i = 0; i < 45; i++) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const response = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "health-check",
            method: "notifications/initialized",
          }),
        });
        if (response.status < 500) {
          serverReady = true;
          break;
        }
      } catch {
        // not ready
      }
    }

    if (!serverReady) {
      throw new Error("Server did not start within expected time");
    }

    await makeJsonRpcCall("execute_sql", {
      schema: "public",
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          mobile_number VARCHAR(20),
          age INTEGER
        );

        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          total DECIMAL(10,2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO users (name, email, mobile_number, age) VALUES
        ('John Doe', 'john@example.com', '+27820000001', 30),
        ('Jane Smith', 'jane@example.com', '+27820000002', 25),
        ('Bob Johnson', 'bob@example.com', '+27820000003', 35);

        INSERT INTO orders (user_id, total) VALUES
        (1, 99.99),
        (1, 149.50),
        (2, 75.25);
      `,
    });
  }, 180000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (serverProcess) {
          serverProcess.on("exit", () => resolve());
          setTimeout(() => {
            if (serverProcess && !serverProcess.killed) {
              serverProcess.kill("SIGKILL");
            }
            resolve();
          }, 5000);
        } else {
          resolve();
        }
      });
    }
    await container?.stop();
  });

  async function makeJsonRpcCall(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.random().toString(36).slice(2, 11),
        method: "tools/call",
        params: {
          name: method,
          arguments: params,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  }

  describe("execute_sql JSON RPC calls", () => {
    it("should execute a simple SELECT query successfully", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: "SELECT id, age FROM users WHERE age > 25 ORDER BY age",
      })) as { result: { content: { text: string }[] } };

      expect(response).toHaveProperty("result");
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(2);
      expect(content.data.rows[0].age).toBe(30);
      expect(content.data.rows[1].age).toBe(35);
    });

    it("should execute a JOIN query successfully", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          SELECT u.id, o.total
          FROM users u
          JOIN orders o ON u.id = o.user_id
          WHERE u.age >= 30
          ORDER BY o.total DESC
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(2);
      expect(Number(content.data.rows[0].total)).toBe(149.5);
      expect(Number(content.data.rows[1].total)).toBe(99.99);
    });

    it("should execute aggregate queries successfully", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          SELECT
            COUNT(*)::int as user_count,
            AVG(age)::numeric(10,2) as avg_age,
            MIN(age) as min_age,
            MAX(age) as max_age
          FROM users
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].user_count).toBe(3);
      expect(Number(content.data.rows[0].avg_age)).toBe(30);
      expect(content.data.rows[0].min_age).toBe(25);
      expect(content.data.rows[0].max_age).toBe(35);
    });

    it("should handle multiple statements in a single call", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 28);
          SELECT COUNT(*)::int as total_users FROM users;
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].total_users).toBe(4);
    });

    it("should run PostgreSQL utility expressions", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          SELECT
            current_database() as db,
            upper('hello world') as uppercase,
            length('test string') as str_length
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].db).toBe("jsonrpctest");
      expect(content.data.rows[0].uppercase).toBe("HELLO WORLD");
      expect(content.data.rows[0].str_length).toBe(11);
    });

    it("should return error for invalid SQL", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: "SELECT id FROM non_existent_table",
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.error.toLowerCase()).toMatch(/non_existent_table|does not exist/);
      expect(content.code).toBe("EXECUTION_ERROR");
    });

    it("should handle empty result sets", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: "SELECT id, age FROM users WHERE age > 100",
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(0);
      expect(content.data.count).toBe(0);
    });

    it("should work with explicit transactions", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          INSERT INTO users (name, email, age) VALUES ('Transaction User', 'transaction@example.com', 40);
          SELECT id, age FROM users WHERE email = 'transaction@example.com';
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].age).toBe(40);
    });

    it("should block access to system catalog schemas", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: `
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.code).toBe("SCHEMA_SCOPE_VIOLATION");
    });

    it("should block cross-schema references outside the target schema", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: "SELECT * FROM pg_catalog.pg_tables",
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.code).toBe("SCHEMA_SCOPE_VIOLATION");
    });

    it("should reject execute_sql calls without a schema argument", async () => {
      // The mandatory `schema` argument is enforced at the MCP input-schema layer,
      // so a missing schema is rejected before the handler runs and surfaces as a
      // JSON-RPC error rather than a tool result.
      const response = (await makeJsonRpcCall("execute_sql", {
        sql: "SELECT 1 as test",
      })) as {
        error?: { message: string };
        result?: { content: { text: string }[] };
      };

      // The rejection may surface either as a JSON-RPC top-level error, or as a
      // tool result whose text is a plain "MCP error ..." string (not our JSON
      // envelope). In every case it must fail and mention the schema requirement.
      const text = response.result?.content?.[0]?.text ?? response.error?.message ?? "";
      let succeeded: boolean | undefined;
      try {
        succeeded = JSON.parse(text).success;
      } catch {
        succeeded = false;
      }
      expect(succeeded).toBe(false);
      expect(text.toLowerCase()).toContain("schema");
    });
  });

  // This server runs with --allow-access-to-pii-data=true, so these live tests
  // prove the flag does NOT unblock health data or non-mobile PII, and DOES
  // permit the mobile/phone number (the Helium username).
  describe("PII / health hard-exclusion (allow_access_to_pii_data=true)", () => {
    async function callSql(sql: string) {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql,
      })) as { result: { content: { text: string }[] } };
      return JSON.parse(response.result.content[0].text);
    }

    it("blocks a personal identifier (email) even with the override on", async () => {
      const content = await callSql("SELECT id, email FROM users WHERE id = 1");
      expect(content.success).toBe(false);
      expect(content.code).toBe("PII_ACCESS_VIOLATION");
      expect(content.details?.reason).toBe("hard_pii_blocked");
    });

    it("blocks a name projection even with the override on", async () => {
      const content = await callSql("SELECT id, name FROM users WHERE id = 1");
      expect(content.success).toBe(false);
      expect(content.code).toBe("PII_ACCESS_VIOLATION");
      expect(content.details?.reason).toBe("hard_pii_blocked");
    });

    it("blocks a wildcard projection even with the override on", async () => {
      const content = await callSql("SELECT * FROM users WHERE id = 1");
      expect(content.success).toBe(false);
      expect(content.code).toBe("PII_ACCESS_VIOLATION");
      expect(content.details?.reason).toBe("wildcard_clinical_risk");
    });

    it("blocks a clinical/health projection even with the override on", async () => {
      // Column need not exist — the guard rejects the projection before execution.
      const content = await callSql("SELECT id, hiv_status FROM users WHERE id = 1");
      expect(content.success).toBe(false);
      expect(content.code).toBe("PII_ACCESS_VIOLATION");
      expect(content.details?.reason).toBe("clinical_health_data_blocked");
    });

    it("allows the mobile/phone number (the Helium username) with the override on", async () => {
      const content = await callSql("SELECT id, mobile_number FROM users WHERE id = 1");
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].mobile_number).toBe("+27820000001");
    });
  });

  describe("JSON RPC protocol compliance", () => {
    it("should return proper JSON RPC response structure", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        schema: "public",
        sql: "SELECT 1 as test",
      })) as { jsonrpc: string; id: string; result: unknown };

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      expect(response).toHaveProperty("result");
    });

    it("should handle malformed requests gracefully", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          id: "test",
          method: "tools/call",
          params: {
            name: "execute_sql",
            arguments: { sql: "SELECT 1" },
          },
        }),
      });

      expect(response.status).toBeLessThan(500);
    });
  });
});
