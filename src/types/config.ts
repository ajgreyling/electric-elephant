/**
 * Configuration types for TOML-based PostgreSQL setup
 */

/**
 * SSH tunnel configuration (inline per-source)
 */
export interface SSHConfig {
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
  ssh_passphrase?: string;
  /**
   * ProxyJump configuration for multi-hop SSH connections.
   * Comma-separated list of jump hosts: "jump1.example.com,user@jump2.example.com:2222"
   */
  ssh_proxy_jump?: string;
  /** Interval in seconds between keepalive packets (default: 0 = disabled) */
  ssh_keepalive_interval?: number;
  /** Maximum number of missed keepalive responses before disconnecting (default: 3) */
  ssh_keepalive_count_max?: number;
}

/**
 * Database connection parameters (alternative to DSN)
 */
export interface ConnectionParams {
  type?: "postgres";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  aws_iam_auth?: boolean; // Enable AWS IAM auth token generation for RDS
  aws_region?: string; // AWS region required when aws_iam_auth is enabled
  sslmode?: "disable" | "require";
}

/**
 * Source configuration from [[sources]] array in TOML
 */
export interface SourceConfig extends ConnectionParams, SSHConfig {
  id: string;
  description?: string; // Human-readable description of this data source
  dsn?: string;
  connection_timeout?: number; // Connection timeout in seconds
  query_timeout?: number; // Query timeout in seconds
  init_script?: string; // Optional SQL script to run on connection
  lazy?: boolean; // Defer connection until first query (default: false)
  search_path?: string; // Comma-separated list of schemas for PostgreSQL search_path (e.g., "myschema,public")
}

/**
 * Custom tool parameter configuration
 */
export interface ParameterConfig {
  name: string;
  type: "string" | "integer" | "float" | "boolean" | "array";
  description: string;
  required?: boolean; // Defaults to true
  default?: any; // Makes parameter optional if set
  allowed_values?: any[]; // Enum constraint
}

/**
 * Built-in tool configuration for execute_sql
 */
export interface ExecuteSqlToolConfig {
  name: "execute_sql"; // Must match BUILTIN_TOOL_EXECUTE_SQL from builtin-tools.ts
  source: string;
  readonly?: boolean;
  max_rows?: number;
  /** When false (default if omitted), execute_sql may block queries that appear to expose PII or sensitive clinical fields. */
  allow_access_to_pii_data?: boolean;
  /**
   * Optional standards-aware profile for clinical projection heuristics.
   * Defaults to all supported standards when omitted.
   */
  clinical_standards?: ("hl7v2" | "fhir" | "loinc" | "snomed")[];
}

/**
 * Built-in tool configuration for search_objects
 */
export interface SearchObjectsToolConfig {
  name: "search_objects"; // Must match BUILTIN_TOOL_SEARCH_OBJECTS from builtin-tools.ts
  source: string;
}

/**
 * Built-in tool configuration for diagnose_locks
 */
export interface DiagnoseLocksToolConfig {
  name: "diagnose_locks";
  source: string;
}

/**
 * Built-in tool configuration for explain_plan
 */
export interface ExplainPlanToolConfig {
  name: "explain_plan";
  source: string;
}

/**
 * Built-in tool configuration for replication_status
 */
export interface ReplicationStatusToolConfig {
  name: "replication_status";
  source: string;
}

/**
 * Built-in tool configuration for table_health
 */
export interface TableHealthToolConfig {
  name: "table_health";
  source: string;
}

/**
 * Built-in tool configuration for extensions_status
 */
export interface ExtensionsStatusToolConfig {
  name: "extensions_status";
  source: string;
}

/**
 * Built-in tool configuration for query_insights
 */
export interface QueryInsightsToolConfig {
  name: "query_insights";
  source: string;
}

/**
 * Built-in tool configuration for schema_diff
 */
export interface SchemaDiffToolConfig {
  name: "schema_diff";
  source: string;
}

/**
 * Custom tool configuration
 */
export interface CustomToolConfig {
  name: string; // Must not be "execute_sql" or "search_objects"
  source: string;
  description: string;
  statement: string;
  parameters?: ParameterConfig[];
  readonly?: boolean;
  max_rows?: number;
}

/**
 * Unified tool configuration (discriminated union)
 */
export type ToolConfig =
  | ExecuteSqlToolConfig
  | SearchObjectsToolConfig
  | DiagnoseLocksToolConfig
  | ExplainPlanToolConfig
  | ReplicationStatusToolConfig
  | TableHealthToolConfig
  | ExtensionsStatusToolConfig
  | QueryInsightsToolConfig
  | SchemaDiffToolConfig
  | CustomToolConfig;

/**
 * Complete TOML configuration file structure
 */
export interface TomlConfig {
  sources: SourceConfig[];
  tools?: ToolConfig[];
}
