import { describe, it, expect } from 'vitest';
import {
  obfuscateDSNPassword,
  obfuscateSSHConfig,
  getDatabaseTypeFromDSN,
  parseConnectionInfoFromDSN,
} from '../dsn-obfuscate.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';

describe('DSN Obfuscation Utilities', () => {
  describe('obfuscateDSNPassword', () => {
    it('should obfuscate password in postgres DSN', () => {
      const dsn = 'postgres://user:secretpass@localhost:5432/db';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:********@localhost:5432/db');
    });

    it('should handle DSN without password', () => {
      const dsn = 'postgres://user@localhost:5432/db';
      expect(obfuscateDSNPassword(dsn)).toBe(dsn);
    });
  });

  describe('obfuscateSSHConfig', () => {
    it('should obfuscate password and passphrase', () => {
      const config: SSHTunnelConfig = {
        host: 'bastion.example.com',
        port: 22,
        username: 'ubuntu',
        password: 'secretpassword',
        passphrase: 'keypassphrase',
      };
      const result = obfuscateSSHConfig(config);
      expect(result.password).toBe('********');
      expect(result.passphrase).toBe('********');
    });
  });

  describe('getDatabaseTypeFromDSN', () => {
    it('should return postgres for postgres and postgresql URLs', () => {
      expect(getDatabaseTypeFromDSN('postgres://u:p@localhost:5432/db')).toBe('postgres');
      expect(getDatabaseTypeFromDSN('postgresql://u:p@localhost:5432/db')).toBe('postgres');
    });

    it('should return undefined for non-Postgres protocols', () => {
      expect(getDatabaseTypeFromDSN('https://example.com/db')).toBeUndefined();
      expect(getDatabaseTypeFromDSN('redis://localhost:6379/0')).toBeUndefined();
      expect(getDatabaseTypeFromDSN('')).toBeUndefined();
    });
  });

  describe('parseConnectionInfoFromDSN', () => {
    it('should parse postgres DSNs', () => {
      expect(parseConnectionInfoFromDSN('postgres://pguser:secret@db.example.com:5433/mydb')).toEqual({
        type: 'postgres',
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        user: 'pguser',
      });
    });

    it('should return null for unsupported DSNs', () => {
      expect(parseConnectionInfoFromDSN('redis://localhost:6379/0')).toBeNull();
    });
  });
});
