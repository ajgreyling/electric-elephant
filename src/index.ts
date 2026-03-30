#!/usr/bin/env node

import { main } from "./server.js";
import { loadConnectors } from "./utils/module-loader.js";

// Each load function uses a string literal so the bundler can resolve it.
const connectorModules = [
  { load: () => import("./connectors/postgres/index.js"), name: "PostgreSQL", driver: "pg" },
];

loadConnectors(connectorModules)
  .then(() => main())
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
