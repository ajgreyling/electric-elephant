import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveTransport, resolvePort, resolveSourceConfigs } from "./config/env.js";
import { registerTools } from "./tools/index.js";
import { listSources, getSource } from "./api/sources.js";
import { listRequests } from "./api/requests.js";
import { generateStartupTable, buildSourceDisplayInfo } from "./utils/startup-table.js";
import { getToolsForSource } from "./utils/tool-metadata.js";
import { startConfigWatcher } from "./utils/config-watcher.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json to get version
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Server info
export const SERVER_NAME = "Electric Elephant MCP Server";
export const SERVER_VERSION = packageJson.version;

function writeStderrLine(message: string): void {
  if (process.env.EE_LOG_STDERR === "true") {
    process.stderr.write(`${message}\n`);
  }
}

/**
 * Generate ASCII art banner with version information
 */
export function generateBanner(version: string, modes: string[] = []): string {
  const modeText = modes.length > 0 ? ` [${modes.join(" | ")}]` : "";
  const art = [
    "      _           _        _             _            _                 _   ",
    "  ___| | ___  ___| |_ _ __(_) ___    ___| | ___ _ __ | |__   __ _ _ __ | |_ ",
    " / _ \\ |/ _ \\/ __| __| '__| |/ __|  / _ \\ |/ _ \\ '_ \\| '_ \\ / _` | '_ \\| __|",
    "|  __/ |  __/ (__| |_| |  | | (__  |  __/ |  __/ |_) | | | | (_| | | | | |_ ",
    " \\___|_|\\___|\\___|\\__|_|  |_|\\___|  \\___|_|\\___| .__/|_| |_|\\__,_|_| |_|\\__|",
    "                                               |_|                          ",
  ].join("\n");
  return `${art}\nv${version}${modeText} - PostgreSQL-Only, Readonly-First MCP Server`;
}

/**
 * Initialize and start the Electric Elephant MCP server
 */
export async function main(): Promise<void> {
  try {
    // Resolve source configurations from TOML or fallback to single DSN
    const sourceConfigsData = await resolveSourceConfigs();

    if (!sourceConfigsData) {
      const samples = ConnectorRegistry.getAllSampleDSNs();
      const sampleFormats = Object.entries(samples)
        .map(([id, dsn]) => `  - ${id}: ${dsn}`)
        .join("\n");

      console.error(`
ERROR: Database connection configuration is required.
Please provide PostgreSQL configuration in one of these ways (in order of priority):

1. TOML config file: --config=path/to/dbhub.toml or ./dbhub.toml
2. Command line argument: --dsn="your-postgres-connection-string"
3. Environment variable: export DSN="your-postgres-connection-string"
4. .env file: DSN=your-postgres-connection-string

Example DSN formats:
${sampleFormats}

Example TOML config (dbhub.toml):
  [[sources]]
  id = "my_db"
  type = "postgres"
  dsn = "postgres://user:pass@localhost:5432/dbname"

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Create connector manager and connect to database(s)
    const connectorManager = new ConnectorManager();
    const sources = sourceConfigsData.sources;

    writeStderrLine(`Configuration source: ${sourceConfigsData.source}`);

    // Connect to database(s) — single DSN or multi-source TOML
    await connectorManager.connectWithSources(sources);

    // Initialize tool registry (manages both built-in and custom tools)
    // This must happen AFTER ConnectorManager is initialized so source validation works
    const { initializeToolRegistry } = await import("./tools/registry.js");
    initializeToolRegistry({
      sources: sourceConfigsData.sources,
      tools: sourceConfigsData.tools,
    });
    writeStderrLine("Tool registry initialized");

    // Start watching TOML config file for hot reload (only when using TOML config).
    // In STDIO mode, tool list is registered once — hot reload updates connections and
    // tool registry, but STDIO clients won't see added/removed tools without restart.
    // HTTP transport creates a new server per request, so tool changes apply immediately.
    const stopConfigWatcher = startConfigWatcher({
      connectorManager,
      initialTools: sourceConfigsData.tools,
    });

    // Create MCP server factory function for HTTP transport
    // Note: This must be created AFTER ConnectorManager is initialized
    const createServer = () => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register tools (both built-in and custom)
      // All tools are validated and managed by the ToolRegistry
      registerTools(server);

      return server;
    };

    // Resolve transport type (for MCP server)
    const transportData = resolveTransport();

    // Resolve port for HTTP server (only needed for http transport)
    const port = transportData.type === "http" ? resolvePort().port : null;

    // Print ASCII art banner with version and slogan
    // Collect active modes
    const activeModes: string[] = [];
    const modeDescriptions: string[] = [];

    if (sourceConfigsData.defaultReadonly) {
      activeModes.push("READ-ONLY");
      modeDescriptions.push("destructive SQL disabled (use --allow-destructive-sql to enable)");
    }

    // Output mode information
    if (activeModes.length > 0) {
      writeStderrLine(`Running in ${activeModes.join(' and ')} mode - ${modeDescriptions.join(', ')}`);
    }

    writeStderrLine(generateBanner(SERVER_VERSION, activeModes));

    // Print sources and tools table
    const sourceDisplayInfos = buildSourceDisplayInfo(
      sources,
      (sourceId) => getToolsForSource(sourceId).map((t) => t.readonly ? `🔒 ${t.name}` : t.name)
    );
    writeStderrLine(generateStartupTable(sourceDisplayInfos));

    // Clean up config watcher when the process is exiting (covers both transports)
    process.on("exit", () => { stopConfigWatcher?.(); });

    // Set up transport-specific server
    if (transportData.type === "http") {
      // HTTP transport: Start Express server with MCP endpoint and workbench
      const app = express();

      // Enable JSON parsing
      app.use(express.json());

      // Handle CORS and security headers
      app.use((req, res, next) => {
        const origin = req.headers.origin;

        res.header('Access-Control-Allow-Origin', origin || 'http://localhost');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });

      // Serve static frontend files
      const frontendPath = path.join(__dirname, "public");
      app.use(express.static(frontendPath));

      // Health check endpoint
      app.get("/healthz", (req, res) => {
        res.status(200).send("OK");
      });

      // Data sources API endpoints
      app.get("/api/sources", listSources);
      app.get("/api/sources/:sourceId", getSource);
      app.get("/api/requests", listRequests);

      // Main endpoint for streamable HTTP transport
      // SSE streaming (GET requests) is not supported in stateless mode
      // Return 405 Method Not Allowed for GET requests to indicate this
      app.get("/mcp", (req, res) => {
        res.status(405).json({
          error: 'Method Not Allowed',
          message: 'SSE streaming is not supported in stateless mode. Use POST requests with JSON responses.'
        });
      });

      app.post("/mcp", async (req, res) => {
        try {
          // In stateless mode, create a new instance of transport and server for each request
          // to ensure complete isolation. A single instance would cause request ID collisions
          // when multiple clients connect concurrently.
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Disable session management for stateless mode
            enableJsonResponse: true // Use JSON responses (SSE not supported in stateless mode)
          });
          const server = createServer();

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("Error handling request:", error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
          }
        }
      });

      // SPA fallback - serve index.html for all non-API routes (production only)
      // In development, the frontend is served by Vite dev server
      if (process.env.NODE_ENV !== 'development') {
        app.get("*", (req, res) => {
          res.sendFile(path.join(frontendPath, "index.html"));
        });
      }

      // Start the HTTP server
      app.listen(port!, '0.0.0.0', () => {
        // In development mode, suggest using the Vite dev server for hot reloading
        if (process.env.NODE_ENV === 'development') {
          writeStderrLine('Development mode detected!');
          writeStderrLine('   Workbench dev server (with HMR): http://localhost:5173');
          writeStderrLine('   Backend API: http://localhost:8080');
          writeStderrLine('');
        } else {
          writeStderrLine(`Workbench at http://localhost:${port}/`);
        }
        writeStderrLine(`MCP server endpoint at http://localhost:${port}/mcp`);
      });
    } else {
      // STDIO transport: Pure MCP-over-stdio, no HTTP server
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      writeStderrLine("MCP server running on stdio");

      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        writeStderrLine("Shutting down...");
        await transport.close();
        await connectorManager.disconnect();
        process.exit(0);
      };

      // Listen for SIGINT/SIGTERM to gracefully shut down
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Exit when stdin closes (parent process terminated).
      // On Windows, SIGINT/SIGTERM are not reliably sent when the parent
      // process exits - detecting stdin EOF is the portable way to handle this.
      process.stdin.on("end", shutdown);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
