// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { encodeEnrollment, decodeEnrollment } from '../../../src/services/hooks/enrollment.js';

describe('enrollment token', () => {
  it('round-trips url + key', () => {
    const t = encodeEnrollment({ url: 'https://100.77.250.118:37700', key: 'cm_abc.def' });
    expect(decodeEnrollment(t)).toEqual({ url: 'https://100.77.250.118:37700', key: 'cm_abc.def' });
  });
  it('throws on malformed token', () => {
    expect(() => decodeEnrollment('not-base64url!!')).toThrow();
  });
  it('throws when decoded JSON is missing url or key', () => {
    const bad = Buffer.from(JSON.stringify({ url: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeEnrollment(bad)).toThrow();
  });
});
