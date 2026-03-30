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
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER
        );

        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          total DECIMAL(10,2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO users (name, email, age) VALUES
        ('John Doe', 'john@example.com', 30),
        ('Jane Smith', 'jane@example.com', 25),
        ('Bob Johnson', 'bob@example.com', 35);

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
        sql: "SELECT * FROM users WHERE age > 25 ORDER BY age",
      })) as { result: { content: { text: string }[] } };

      expect(response).toHaveProperty("result");
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(2);
      expect(content.data.rows[0].name).toBe("John Doe");
      expect(content.data.rows[1].name).toBe("Bob Johnson");
    });

    it("should execute a JOIN query successfully", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        sql: `
          SELECT u.name, u.email, o.total
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
        sql: "SELECT * FROM non_existent_table",
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.error.toLowerCase()).toMatch(/non_existent_table|does not exist/);
      expect(content.code).toBe("EXECUTION_ERROR");
    });

    it("should handle empty result sets", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        sql: "SELECT * FROM users WHERE age > 100",
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(0);
      expect(content.data.count).toBe(0);
    });

    it("should work with explicit transactions", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        sql: `
          BEGIN;
          INSERT INTO users (name, email, age) VALUES ('Transaction User', 'transaction@example.com', 40);
          COMMIT;
          SELECT * FROM users WHERE email = 'transaction@example.com';
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].name).toBe("Transaction User");
      expect(content.data.rows[0].age).toBe(40);
    });

    it("should describe table columns via information_schema", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
        sql: `
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `,
      })) as { result: { content: { text: string }[] } };

      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      const names = content.data.rows.map((r: { column_name: string }) => r.column_name);
      expect(names).toContain("id");
      expect(names).toContain("name");
    });
  });

  describe("JSON RPC protocol compliance", () => {
    it("should return proper JSON RPC response structure", async () => {
      const response = (await makeJsonRpcCall("execute_sql", {
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
