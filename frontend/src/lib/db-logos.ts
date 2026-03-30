import type { DatabaseType } from '../types/datasource';
import PostgresLogo from '../assets/logos/postgres.svg';

export const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: PostgresLogo,
};
