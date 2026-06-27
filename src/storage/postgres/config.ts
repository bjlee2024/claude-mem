// SPDX-License-Identifier: Apache-2.0

export interface PostgresConnection {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
}

export interface PostgresConfig {
  connectionString: string;
  connection: PostgresConnection;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  ssl: boolean | { rejectUnauthorized: boolean };
}

export interface ParsePostgresConfigOptions {
  env?: NodeJS.ProcessEnv;
  requireDatabaseUrl?: boolean;
}

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export function getPostgresDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CLAUDE_MEM_SERVER_DATABASE_URL || null;
}

export function parsePostgresConfig(options: ParsePostgresConfigOptions = {}): PostgresConfig | null {
  const env = options.env ?? process.env;
  const connectionString = getPostgresDatabaseUrl(env);
  if (!connectionString) {
    if (options.requireDatabaseUrl) {
      throw new Error('Postgres requires CLAUDE_MEM_SERVER_DATABASE_URL');
    }
    return null;
  }

  return {
    connectionString,
    connection: parseConnection(connectionString),
    max: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
    statementTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS),
    ssl: parseSsl(connectionString, env)
  };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseConnection(connectionString: string): PostgresConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('CLAUDE_MEM_SERVER_DATABASE_URL is not a valid URL');
  }
  const dbName = url.pathname && url.pathname !== '/' ? safeDecode(url.pathname.replace(/^\//, '')) : undefined;
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    user: url.username ? safeDecode(url.username) : undefined,
    password: url.password ? safeDecode(url.password) : undefined,
    database: dbName,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSsl(connectionString: string, env: NodeJS.ProcessEnv): boolean | { rejectUnauthorized: boolean } {
  if (env.CLAUDE_MEM_POSTGRES_SSL === 'disable' || env.PGSSLMODE === 'disable') {
    return false;
  }
  if (env.CLAUDE_MEM_POSTGRES_SSL === 'require' || env.PGSSLMODE === 'require') {
    return { rejectUnauthorized: false };
  }

  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'require') {
      return { rejectUnauthorized: false };
    }
  } catch {
    return false;
  }

  return false;
}
