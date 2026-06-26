import { describe, it, expect } from 'bun:test';
import { toJsonbText } from '../../../../src/storage/postgres/utils.js';

// Postgres `jsonb` rejects lone UTF-16 surrogates with
//   ERROR: invalid input syntax for type json
//   DETAIL: Unicode low surrogate must follow a high surrogate.
// This happens when tool output is truncated mid-character before it reaches
// the ingest path. `toJsonbText` must produce text that pg's jsonb parser
// always accepts. We assert the two failure shapes the parser cares about:
//   (1) no lone-surrogate ESCAPE (\udXXX) survives in the serialized text, and
//   (2) no lone-surrogate CODE UNIT survives in the parsed string values,
// while leaving valid surrogate pairs (real emoji) intact.

const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;
const LONE_UNIT = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('toJsonbText — Postgres jsonb-safe serialization', () => {
  it('neutralizes a lone HIGH surrogate in a string value', () => {
    const out = toJsonbText({ text: 'truncated \uD83D' }); // emoji cut in half
    expect(LONE_ESCAPE.test(out)).toBe(false);
    const parsed = JSON.parse(out);
    expect(LONE_UNIT.test(parsed.text)).toBe(false);
    expect(parsed.text).toContain('�');
  });

  it('neutralizes a lone LOW surrogate in a string value', () => {
    const out = toJsonbText({ text: '\uDE00 dangling' });
    expect(LONE_ESCAPE.test(out)).toBe(false);
    expect(LONE_UNIT.test(JSON.parse(out).text)).toBe(false);
  });

  it('preserves a valid surrogate pair (real emoji) byte-for-byte', () => {
    const emoji = '😀'; // 😀 U+1F600
    const out = toJsonbText({ text: `hi ${emoji}!` });
    expect(JSON.parse(out).text).toBe(`hi ${emoji}!`);
  });

  it('neutralizes lone surrogates nested in objects and arrays', () => {
    const out = toJsonbText({ a: { b: ['ok', 'x\uD83Dy'], c: 'fine' } });
    expect(LONE_ESCAPE.test(out)).toBe(false);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(LONE_UNIT.test(JSON.parse(out).a.b[1])).toBe(false);
  });

  it('neutralizes a lone surrogate in an object KEY (replacer cannot rewrite keys)', () => {
    const out = toJsonbText({ ['k\uDE00']: 1 });
    expect(LONE_ESCAPE.test(out)).toBe(false);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('defaults null/undefined to an empty object', () => {
    expect(toJsonbText(undefined)).toBe('{}');
    expect(toJsonbText(null)).toBe('{}');
  });

  it('passes clean values through as ordinary JSON', () => {
    expect(toJsonbText({ a: 1, b: 'two', c: [true, null] })).toBe('{"a":1,"b":"two","c":[true,null]}');
  });
});
