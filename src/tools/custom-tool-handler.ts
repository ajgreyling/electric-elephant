/**
 * Custom Tool Handler
 * Creates MCP tool handlers for custom SQL-based tools defined in TOML config
 */

import { z } from "zod";
import { ToolConfig, ParameterConfig, CustomToolConfig } from "../types/config.js";
import { ConnectorManager } from "../connectors/manager.js";
import {
  createToolSuccessResponse,
  createToolErrorResponse,
} from "../utils/response-formatter.js";
import { mapArgumentsToArray } from "../utils/parameter-mapper.js";
import {
  isAllowedInReadonlyMode,
  createReadonlyViolationMessage,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";
import { validateSqlSchemaScope } from "../utils/sql-schema-scope.js";
import { validateSqlPiiAccessGuard } from "../utils/pii-sql-guard.js";
import { schemaExists, validateTargetSchemaArg } from "../utils/target-schema.js";

const SCHEMA_PARAM_NAME = "schema";

/**
 * Build a Zod schema from parameter definitions
 * Returns a plain object with Zod schemas (MCP SDK format)
 * @param parameters Parameter configurations from TOML
 * @returns Plain object with Zod type definitions
 */
export function buildZodSchemaFromParameters(
  parameters: ParameterConfig[] | undefined
): Record<string, z.ZodTypeAny> {
  if (!parameters || parameters.length === 0) {
    return {};
  }

  const schemaShape: Record<string, z.ZodTypeAny> = {};

  for (const param of parameters) {
    if (param.name === SCHEMA_PARAM_NAME) {
      throw new Error(
        `Custom tool parameter name '${SCHEMA_PARAM_NAME}' is reserved for the mandatory target schema argument`
      );
    }

    let fieldSchema: z.ZodTypeAny;

    // Build base schema based on type
    switch (param.type) {
      case "string":
        fieldSchema = z.string().describe(param.description);
        break;
      case "integer":
        fieldSchema = z.number().int().describe(param.description);
        break;
      case "float":
        fieldSchema = z.number().describe(param.description);
        break;
      case "boolean":
        fieldSchema = z.boolean().describe(param.description);
        break;
      case "array":
        fieldSchema = z.array(z.unknown()).describe(param.description);
        break;
      default:
        throw new Error(`Unsupported parameter type: ${param.type}`);
    }

    // Add enum constraint if allowed_values is specified
    if (param.allowed_values && param.allowed_values.length > 0) {
      if (param.type === "string") {
        fieldSchema = z.enum(param.allowed_values as [string, ...string[]]).describe(param.description);
      } else {
        // For non-string types, use refine to validate against allowed values
        fieldSchema = fieldSchema.refine(
          (val) => param.allowed_values!.includes(val),
          {
            message: `Value must be one of: ${param.allowed_values.join(", ")}`,
          }
        );
      }
    }

    // Make field optional if it has a default value or is explicitly marked as not required
    if (param.default !== undefined || param.required === false) {
      fieldSchema = fieldSchema.optional();
    }

    schemaShape[param.name] = fieldSchema;
  }

  return schemaShape;
}

/**
 * Build input schema in MCP format (JSON Schema compatible)
 * @param parameters Parameter configurations from TOML
 * @returns JSON Schema object
 */
export function buildInputSchema(parameters: ParameterConfig[] | undefined): {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
} {
  // Convert Zod schema to JSON Schema-like format for MCP
  const properties: Record<string, any> = {
    [SCHEMA_PARAM_NAME]: {
      type: "string",
      description: "Target schema for this query (required)",
    },
  };
  const required: string[] = [SCHEMA_PARAM_NAME];

  if (parameters) {
    for (const param of parameters) {
      if (param.name === SCHEMA_PARAM_NAME) {
        throw new Error(
          `Custom tool parameter name '${SCHEMA_PARAM_NAME}' is reserved for the mandatory target schema argument`
        );
      }

      const propSchema: any = {
        description: param.description,
      };

      // Map type to JSON Schema type
      switch (param.type) {
        case "string":
          propSchema.type = "string";
          break;
        case "integer":
          propSchema.type = "integer";
          break;
        case "float":
          propSchema.type = "number";
          break;
        case "boolean":
          propSchema.type = "boolean";
          break;
        case "array":
          propSchema.type = "array";
          break;
      }

      // Add enum if allowed_values specified
      if (param.allowed_values && param.allowed_values.length > 0) {
        propSchema.enum = param.allowed_values;
      }

      properties[param.name] = propSchema;

      // Track required fields
      if (param.required !== false && param.default === undefined) {
        required.push(param.name);
      }
    }
  }

  const schema: any = {
    type: "object",
    properties,
    required,
  };

  return schema;
}

/**
 * Create a custom tool handler for a user-defined SQL tool
 * @param toolConfig Tool configuration from TOML
 * @returns Handler function compatible with MCP server.registerTool
 */
export function createCustomToolHandler(toolConfig: ToolConfig) {
  const customConfig = toolConfig as CustomToolConfig;
  const zodSchemaShape = {
    [SCHEMA_PARAM_NAME]: z.string().min(1).describe("Target schema for this query (required)"),
    ...buildZodSchemaFromParameters(customConfig.parameters),
  };
  const zodSchema = z.object(zodSchemaShape);

  return async (args: any, extra: any) => {
    const startTime = Date.now();
    let success = true;
    let errorMessage: string | undefined;
    let paramValues: any[] = [];

    try {
      const validatedArgs = zodSchema.parse(args);
      const { schema, ...toolArgs } = validatedArgs as { schema: string; [key: string]: unknown };

      await ConnectorManager.ensureConnected(customConfig.source);
      const connector = ConnectorManager.getCurrentConnector(customConfig.source);

      const allowlistResult = validateTargetSchemaArg(schema, customConfig.allowed_schemas);
      if (!allowlistResult.ok) {
        errorMessage = allowlistResult.message;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: allowlistResult.reason,
        });
      }

      if (!(await schemaExists(connector, schema))) {
        errorMessage = `Schema '${schema}' does not exist`;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
      }

      const scopeResult = validateSqlSchemaScope(customConfig.statement, schema);
      if (!scopeResult.ok) {
        errorMessage = scopeResult.message;
        success = false;
        return createToolErrorResponse(errorMessage, "SCHEMA_SCOPE_VIOLATION", {
          reason: scopeResult.reason,
          reference: scopeResult.reference,
        });
      }

      // Clinical/health data (HL7v2, FHIR, LOINC, SNOMED, medical fields) is
      // hard-excluded from every row-returning tool. Passing allowAccess=true
      // runs only the un-overridable clinical + wildcard-risk checks, not the
      // generic-PII checks (custom tool statements are curated by the operator).
      const piiGuard = validateSqlPiiAccessGuard(customConfig.statement, true);
      if (!piiGuard.ok) {
        errorMessage = piiGuard.message;
        success = false;
        return createToolErrorResponse(piiGuard.message, "PII_ACCESS_VIOLATION", {
          reason: piiGuard.reason,
          matches: piiGuard.matches,
        });
      }

      const executeOptions = {
        readonly: customConfig.readonly,
        maxRows: customConfig.max_rows,
        targetSchema: schema,
      };

      const isReadonly = executeOptions.readonly === true;
      if (isReadonly && !isAllowedInReadonlyMode(customConfig.statement, connector.id)) {
        errorMessage = createReadonlyViolationMessage(customConfig.name, customConfig.source, connector.id);
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      paramValues = mapArgumentsToArray(customConfig.parameters, toolArgs);

      const result = await connector.executeSQL(
        customConfig.statement,
        executeOptions,
        paramValues
      );

      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: customConfig.source,
        schema,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;

      if (error instanceof z.ZodError) {
        const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        errorMessage = `Parameter validation failed: ${issues}`;
      } else {
        // The statement is operator-defined (safe to surface), but parameter
        // VALUES are runtime input that may be personal data — describe them by
        // count/type instead of echoing values back to the client.
        const paramTypes = paramValues.map((p) => (p === null ? "null" : typeof p));
        const paramSummary =
          paramValues.length > 0 ? `${paramValues.length} param(s) [${paramTypes.join(", ")}]` : "none";
        errorMessage = `${errorMessage}\n\nSQL: ${customConfig.statement}\nParameters: ${paramSummary}`;
      }

      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: customConfig.source,
          toolName: customConfig.name,
          sql: customConfig.statement,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
