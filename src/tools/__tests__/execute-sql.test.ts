import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../registry.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');
vi.mock('../registry.js');

// Mock connector for testing
const createMockConnector = (id: ConnectorType = 'postgres', sourceId: string = 'default'): Connector => ({
  id,
  name: 'Mock Connector',
  getId: () => sourceId,
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  tableExists: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
});

// Helper function to parse tool response
const parseToolResponse = (response: any) => {
  return JSON.parse(response.content[0].text);
};

describe('execute-sql tool', () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  beforeEach(() => {
    mockConnector = createMockConnector('postgres');
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);

    // Mock tool registry to return empty config (no readonly, no max_rows)
    mockGetToolRegistry.mockReturnValue({
      getBuiltinToolConfig: vi.fn().mockReturnValue({}),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic execution', () => {
    it('should execute SELECT and return rows', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1, status: 'active' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, status FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.rows).toEqual([{ id: 1, status: 'active' }]);
      expect(parsedResult.data.count).toBe(1);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT id, status FROM users', { readonly: undefined, maxRows: undefined, targetSchema: 'public' });
    });

    it('should pass multi-statement SQL directly to connector', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT id FROM users; SELECT id FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, { readonly: undefined, maxRows: undefined, targetSchema: 'public' });
    });

    it('should handle execution errors', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('Database error'));

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id FROM invalid_table' }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toBe('Database error');
      expect(parsedResult.code).toBe('EXECUTION_ERROR');
    });
  });

  describe('read-only mode enforcement', () => {
    beforeEach(() => {
      // Set per-source readonly mode via tool registry (simulates TOML config)
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          readonly: true,
          allow_access_to_pii_data: true,
        }),
      } as any);
    });

    it('should allow SELECT statements', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, status FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT id, status FROM users', { readonly: true, maxRows: undefined, targetSchema: 'public' });
    });

    it('should allow multiple read-only statements', async () => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT id FROM users; SELECT id FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it.each([
      ['INSERT', "INSERT INTO users (name) VALUES ('test')"],
      ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
      ['DELETE', "DELETE FROM users WHERE id = 1"],
      ['DROP', "DROP TABLE users"],
      ['CREATE', "CREATE TABLE test (id INT)"],
      ['ALTER', "ALTER TABLE users ADD COLUMN email VARCHAR(255)"],
      ['TRUNCATE', "TRUNCATE TABLE users"],
    ])('should reject %s statement', async (_, sql) => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should reject multi-statement with any write operation', async () => {
      const sql = "SELECT * FROM users; INSERT INTO users (name) VALUES ('test');";
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

  });

  describe('readonly per-source isolation', () => {
    // Verifies readonly is enforced per-source from tool registry, not globally

    it.each([
      ['readonly: false', { readonly: false }],
      ['readonly: undefined', {}],
    ])('should allow writes when %s', async (_, toolConfig) => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue(toolConfig),
      } as any);
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('writable_source');
      const result = await handler({ schema: 'public', sql: "INSERT INTO users (name) VALUES ('test')" }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalled();
    });

    it('should enforce readonly even with other options set', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          readonly: true,
          max_rows: 100,
          allow_access_to_pii_data: true,
        }),
      } as any);

      const handler = createExecuteSqlToolHandler('limited_source');
      const result = await handler({ schema: 'public', sql: "DELETE FROM users" }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });
  });

  describe('SQL comments handling in readonly mode', () => {
    beforeEach(() => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          readonly: true,
          allow_access_to_pii_data: true,
        }),
      } as any);
    });

    it.each([
      ['single-line comment', '-- Fetch users\nSELECT id, status FROM users'],
      ['multi-line comment', '/* Fetch all */\nSELECT id, title FROM products'],
      ['inline comments', 'SELECT id, -- user id\n       status FROM users'],
    ])('should allow SELECT with %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it('should reject comment-only SQL in readonly mode', async () => {
      const sql = '-- Just a comment\n/* Another */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject batch when second statement is only a strippable comment', async () => {
      const sql = 'SELECT 1; /*!50000 DROP TABLE users */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject write statement hidden after comment', async () => {
      const sql = '-- Insert new user\nINSERT INTO users (name) VALUES (\'test\')';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });
  });

  describe('PII / clinical access guardrail', () => {
    it('should block SELECT * when allow_access_to_pii_data is not enabled', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT * FROM users' }, null);

      expect(result.isError).toBe(true);
      const parsed = parseToolResponse(result);
      expect(parsed.code).toBe('PII_ACCESS_VIOLATION');
      expect(parsed.details?.reason).toBe('wildcard_clinical_risk');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block table.* projections', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT u.* FROM users u' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block generic PII column names (email) as hard-excluded', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, email FROM users' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('hard_pii_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block mobile/phone (overridable field) when access is not enabled', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, mobile_number FROM users' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('suspected_pii_or_clinical_column');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block clinical / blood-work style column names', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, blood_glucose FROM labs' }, null);

      const parsed = parseToolResponse(result);
      expect(parsed.code).toBe('PII_ACCESS_VIOLATION');
      expect(parsed.details?.reason).toBe('clinical_health_data_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block eLabs HL7 and result payload fields', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { schema: 'public', sql: 'SELECT barcode, orderID, hl7messagecontrolid, resultForAction FROM results_integration' },
        null
      );

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('clinical_health_data_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should block FHIR/LOINC/SNOMED projection names by default', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { schema: 'public', sql: 'SELECT subject_reference, loinc_code, snomed_ct_code FROM observations' },
        null
      );

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('clinical_health_data_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should still block clinical data even when clinical_standards is narrowed', async () => {
      // A narrowed clinical_standards list cannot un-block hard-excluded health data.
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          clinical_standards: ['hl7v2'],
        }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT subject_reference FROM observations' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('clinical_health_data_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should allow benign column lists when guard is active', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, status_code FROM orders' }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalled();
    });

    it('should still block wildcards even when allow_access_to_pii_data is true (hard exclusion)', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ allow_access_to_pii_data: true }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT * FROM users' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('wildcard_clinical_risk');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should still block clinical/health columns even when allow_access_to_pii_data is true (hard exclusion)', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ allow_access_to_pii_data: true }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { schema: 'public', sql: 'SELECT barcode, hl7messagecontrolid FROM results_integration' },
        null
      );

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('clinical_health_data_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should still block generic PII (email) even when allow_access_to_pii_data is true (hard exclusion)', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ allow_access_to_pii_data: true }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, email FROM users' }, null);

      expect(parseToolResponse(result).code).toBe('PII_ACCESS_VIOLATION');
      expect(parseToolResponse(result).details?.reason).toBe('hard_pii_blocked');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should allow mobile/phone number (Helium username) when allow_access_to_pii_data is true', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ allow_access_to_pii_data: true }),
      } as any);
      const mockResult: SQLResult = { rows: [{ id: 1, mobile_number: '+27820000000' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT id, mobile_number FROM users' }, null);
      const parsed = parseToolResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.rows).toEqual([{ id: 1, mobile_number: '+27820000000' }]);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT id, mobile_number FROM users', {
        readonly: undefined,
        maxRows: undefined,
        targetSchema: 'public',
      });
    });
  });

  describe('edge cases', () => {
    it.each([
      ['empty string', ''],
      ['only semicolons and whitespace', '   ;  ;  ; '],
    ])('should handle %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });
  });

  describe('schema scope enforcement', () => {
    it('blocks cross-schema SQL even when allow_access_to_pii_data is true', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          allow_access_to_pii_data: true,
          readonly: false,
        }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { schema: 'public', sql: 'SELECT email FROM other_schema.patients' },
        null
      );
      const parsed = parseToolResponse(result);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SCHEMA_SCOPE_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('blocks destructive cross-schema SQL when readonly is false', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: false }),
      } as any);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { schema: 'public', sql: "UPDATE other_schema.users SET name = 'x'" },
        null
      );
      const parsed = parseToolResponse(result);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SCHEMA_SCOPE_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('rejects schema not in allowed_schemas allowlist', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ allowed_schemas: ['clinical'] }),
      } as any);
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['clinical', 'public']);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ schema: 'public', sql: 'SELECT 1' }, null);
      const parsed = parseToolResponse(result);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SCHEMA_SCOPE_VIOLATION');
    });
  });
});
