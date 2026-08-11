import { describe, it, expect } from 'bun:test';
import { formatObservationTitle } from '../../src/shared/format-observation-title.js';

describe('formatObservationTitle', () => {
  it('작성자가 있으면 "by <user>, <title>" 형태로 만든다', () => {
    expect(formatObservationTitle('NPM Registry Latest Version', 'bjlee2024'))
      .toBe('by bjlee2024, NPM Registry Latest Version');
  });

  it('작성자가 없으면 제목만 반환한다', () => {
    expect(formatObservationTitle('Version Bump Implemented', null))
      .toBe('Version Bump Implemented');
    expect(formatObservationTitle('Version Bump Implemented', undefined))
      .toBe('Version Bump Implemented');
  });

  it('작성자가 빈 문자열이면 제목만 반환한다', () => {
    expect(formatObservationTitle('Some Title', '')).toBe('Some Title');
    expect(formatObservationTitle('Some Title', '   ')).toBe('Some Title');
  });

  it('제목이 없으면 Untitled로 대체한다', () => {
    expect(formatObservationTitle(null, 'superman')).toBe('by superman, Untitled');
    expect(formatObservationTitle(null, null)).toBe('Untitled');
  });
});
