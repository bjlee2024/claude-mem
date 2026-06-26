import { describe, it, expect } from 'bun:test';
import { SERVER_BETA_POSTGRES_TABLES, SERVER_BETA_POSTGRES_SCHEMA_VERSION } from '../../../../src/storage/postgres/schema.js';

describe('worker_certs schema', () => {
  it('registers worker_certs and bumps the schema version to 3', () => {
    expect(SERVER_BETA_POSTGRES_TABLES).toContain('worker_certs');
    expect(SERVER_BETA_POSTGRES_SCHEMA_VERSION).toBe(3);
  });
});
