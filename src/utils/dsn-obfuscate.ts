import type { SSHTunnelConfig } from '../types/ssh.js';
import type { ConnectorType } from '../connectors/interface.js';
import { SafeURL } from './safe-url.js';

/**
 * Parsed connection information from a DSN string
 * Used to populate SourceConfig fields when DSN is provided
 */
export interface ParsedConnectionInfo {
  type?: ConnectorType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

/**
 * Parse connection information from a PostgreSQL DSN string
 */
export function parseConnectionInfoFromDSN(dsn: string): ParsedConnectionInfo | null {
  if (!dsn) {
    return null;
  }

  try {
    const type = getDatabaseTypeFromDSN(dsn);
    if (typeof type === 'undefined') {
      return null;
    }

    const url = new SafeURL(dsn);

    const info: ParsedConnectionInfo = { type };

    if (url.hostname) {
      info.host = url.hostname;
    }

    if (url.port) {
      info.port = parseInt(url.port, 10);
    }

    if (url.pathname && url.pathname.length > 1) {
      info.database = url.pathname.substring(1);
    }

    if (url.username) {
      info.user = url.username;
    }

    return info;
  } catch {
    return null;
  }
}

/**
 * Obfuscates the password in a DSN string for logging purposes
 */
export function obfuscateDSNPassword(dsn: string): string {
  if (!dsn) {
    return dsn;
  }

  try {
    const url = new SafeURL(dsn);

    if (!url.password) {
      return dsn;
    }

    const obfuscatedPassword = '*'.repeat(Math.min(url.password.length, 8));
    const protocol = dsn.split(':')[0];

    let result;
    if (url.username) {
      result = `${protocol}://${url.username}:${obfuscatedPassword}@${url.hostname}`;
    } else {
      result = `${protocol}://${obfuscatedPassword}@${url.hostname}`;
    }
    if (url.port) {
      result += `:${url.port}`;
    }
    result += url.pathname;

    if (url.searchParams.size > 0) {
      const params: string[] = [];
      url.forEachSearchParam((value, key) => {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      });
      result += `?${params.join('&')}`;
    }

    return result;
  } catch {
    return dsn;
  }
}

/**
 * Obfuscates sensitive information in SSH configuration for logging
 */
export function obfuscateSSHConfig(config: SSHTunnelConfig): Partial<SSHTunnelConfig> {
  const obfuscated: Partial<SSHTunnelConfig> = {
    host: config.host,
    port: config.port,
    username: config.username,
  };
  
  if (config.password) {
    obfuscated.password = '*'.repeat(8);
  }
  
  if (config.privateKey) {
    obfuscated.privateKey = config.privateKey;
  }
  
  if (config.passphrase) {
    obfuscated.passphrase = '*'.repeat(8);
  }
  
  return obfuscated;
}

/**
 * Extracts the database type from a DSN string (postgres/postgresql only).
 */
export function getDatabaseTypeFromDSN(dsn: string): ConnectorType | undefined {
  if (!dsn) {
    return undefined;
  }

  const protocol = dsn.split(':')[0];
  return protocolToConnectorType(protocol);
}

function protocolToConnectorType(protocol: string): ConnectorType | undefined {
  if (protocol === 'postgres' || protocol === 'postgresql') {
    return 'postgres';
  }
  return undefined;
}

/**
 * Default port for PostgreSQL
 */
export function getDefaultPortForType(type: ConnectorType): number | undefined {
  if (type === 'postgres') {
    return 5432;
  }
  return undefined;
}
