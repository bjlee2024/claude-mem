// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { normalizeRuntimeValue } from '../../../src/services/hooks/runtime-selector.js';

describe('runtime selector — client alias', () => {
  it('normalizes runtime values', () => {
    expect(normalizeRuntimeValue('client')).toBe('client');
    expect(normalizeRuntimeValue('server-beta')).toBe('server-beta');
    expect(normalizeRuntimeValue('worker')).toBe('worker');
    expect(normalizeRuntimeValue(undefined)).toBe('worker');
    expect(normalizeRuntimeValue('CLIENT')).toBe('client'); // case-insensitive
  });
});
