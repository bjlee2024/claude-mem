import { describe, it, expect } from 'bun:test';
import { buildSearchQuery } from '../../src/storage/postgres/observations.js';

// Finds the placeholder number bound to a specific clause and returns the
// param value stored at that index. This anchors an assertion to *which*
// clause a placeholder belongs to, not just to the fact that some number
// with that value appears in the params array — so a transposition (e.g.
// LIMIT and the gitUser clause swapping which $n they reference) fails here
// even though the placeholder set is still a contiguous 1..n of the right size.
function valueForClause(sql: string, params: unknown[], clausePattern: RegExp): unknown {
  const match = sql.match(clausePattern);
  if (!match) {
    throw new Error(`clause pattern not found in sql: ${clausePattern}`);
  }
  const index = Number(match[1]) - 1;
  return params[index];
}

describe('buildSearchQuery', () => {
  it('검색어가 있으면 tsvector 조건과 ts_rank 정렬을 쓴다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20,
    });
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('ts_rank');
    expect(params).toEqual(['p1', 't1', 'deployment', 20]);
  });

  it('검색어가 없으면 tsvector 조건 없이 최신순으로 정렬한다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20,
    });
    expect(sql).not.toContain('websearch_to_tsquery');
    expect(sql).not.toContain('ts_rank');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['p1', 't1', 20]);
  });

  it('검색어와 작성자를 함께 주면 둘 다 조건에 들어간다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20, gitUser: 'alice',
    });
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain("metadata->>'gitUser'");
    expect(params).toEqual(['p1', 't1', 'deployment', 20, 'alice']);
  });

  it('검색어 없이 작성자만 주면 작성자 조건만 들어간다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20, gitUser: 'alice',
    });
    expect(sql).not.toContain('websearch_to_tsquery');
    expect(sql).toContain("metadata->>'gitUser'");
    expect(params).toEqual(['p1', 't1', 20, 'alice']);
  });

  it('모든 분기에서 플레이스홀더 개수와 파라미터 개수가 일치한다', () => {
    const cases = [
      { projectId: 'p', teamId: 't', query: 'q', limit: 5 },
      { projectId: 'p', teamId: 't', limit: 5 },
      { projectId: 'p', teamId: 't', query: 'q', limit: 5, gitUser: 'a' },
      { projectId: 'p', teamId: 't', limit: 5, gitUser: 'a' },
    ];
    for (const input of cases) {
      const { sql, params } = buildSearchQuery(input);
      // $1..$n 중 서로 다른 번호의 개수가 파라미터 배열 길이와 같아야 한다.
      const distinct = new Set(sql.match(/\$\d+/g) ?? []);
      expect(distinct.size).toBe(params.length);
      // 번호가 1..n 연속인지도 확인 — 건너뛴 번호가 있으면 postgres가 거부한다.
      const numbers = [...distinct].map(p => Number(p.slice(1))).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: params.length }, (_, i) => i + 1));
    }
  });

  // Each of these anchors a specific clause to the placeholder it actually
  // uses, by reading the params value stored at that placeholder's index.
  // A transposition — e.g. LIMIT and the gitUser clause swapping $n's while
  // the overall set of numbers stays a valid contiguous 1..n — flips which
  // value lands where and trips at least one of these checks.

  it('검색어만 있는 분기: 각 절이 올바른 파라미터를 가리킨다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20,
    });
    expect(valueForClause(sql, params, /project_id = \$(\d+)/)).toBe('p1');
    expect(valueForClause(sql, params, /team_id = \$(\d+)/)).toBe('t1');
    expect(valueForClause(sql, params, /content_search @@ websearch_to_tsquery\('english', \$(\d+)\)/)).toBe('deployment');
    expect(valueForClause(sql, params, /ts_rank\(content_search, websearch_to_tsquery\('english', \$(\d+)\)\)/)).toBe('deployment');
    expect(valueForClause(sql, params, /LIMIT \$(\d+)/)).toBe(20);
  });

  it('검색어가 없는 분기: 각 절이 올바른 파라미터를 가리킨다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20,
    });
    expect(valueForClause(sql, params, /project_id = \$(\d+)/)).toBe('p1');
    expect(valueForClause(sql, params, /team_id = \$(\d+)/)).toBe('t1');
    expect(valueForClause(sql, params, /LIMIT \$(\d+)/)).toBe(20);
  });

  it('검색어 + 작성자 분기: 각 절이 올바른 파라미터를 가리킨다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20, gitUser: 'alice',
    });
    expect(valueForClause(sql, params, /project_id = \$(\d+)/)).toBe('p1');
    expect(valueForClause(sql, params, /team_id = \$(\d+)/)).toBe('t1');
    expect(valueForClause(sql, params, /content_search @@ websearch_to_tsquery\('english', \$(\d+)\)/)).toBe('deployment');
    expect(valueForClause(sql, params, /ts_rank\(content_search, websearch_to_tsquery\('english', \$(\d+)\)\)/)).toBe('deployment');
    expect(valueForClause(sql, params, /LIMIT \$(\d+)/)).toBe(20);
    expect(valueForClause(sql, params, /metadata->>'gitUser' = \$(\d+)/)).toBe('alice');
  });

  it('작성자만 있는 분기: 각 절이 올바른 파라미터를 가리킨다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20, gitUser: 'alice',
    });
    expect(valueForClause(sql, params, /project_id = \$(\d+)/)).toBe('p1');
    expect(valueForClause(sql, params, /team_id = \$(\d+)/)).toBe('t1');
    expect(valueForClause(sql, params, /LIMIT \$(\d+)/)).toBe(20);
    expect(valueForClause(sql, params, /metadata->>'gitUser' = \$(\d+)/)).toBe('alice');
  });
});
