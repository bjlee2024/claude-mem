import { describe, it, expect } from 'bun:test';
import { parsePostgresConfig } from '../../../src/storage/postgres/config.js';

describe('parsePostgresConfig — discrete connection parsing', () => {
  it('parses an UNENCODED @ in the password without mangling the host', () => {
    const cfg = parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://admin:medit@123@postgres:5432/claudemem' }, requireDatabaseUrl: true })!;
    expect(cfg.connection.host).toBe('postgres');
    expect(cfg.connection.port).toBe(5432);
    expect(cfg.connection.user).toBe('admin');
    expect(cfg.connection.password).toBe('medit@123');
    expect(cfg.connection.database).toBe('claudemem');
  });

  it('parses a URL-ENCODED password (%40) to the same raw value', () => {
    const cfg = parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://admin:medit%40123@postgres:5432/claudemem' }, requireDatabaseUrl: true })!;
    expect(cfg.connection.host).toBe('postgres');
    expect(cfg.connection.password).toBe('medit@123');
    expect(cfg.connection.database).toBe('claudemem');
  });

  it('handles a normal password and non-default port', () => {
    const cfg = parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://u:p@db.example.com:6543/mydb' }, requireDatabaseUrl: true })!;
    expect(cfg.connection.host).toBe('db.example.com');
    expect(cfg.connection.port).toBe(6543);
    expect(cfg.connection.user).toBe('u');
    expect(cfg.connection.password).toBe('p');
    expect(cfg.connection.database).toBe('mydb');
  });

  it('throws a clear error on a non-URL connection string', () => {
    expect(() => parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: 'not a url' }, requireDatabaseUrl: true })).toThrow();
  });
});
