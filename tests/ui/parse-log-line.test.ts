import { describe, it, expect } from 'bun:test';
import { parseLogLine } from '../../src/ui/viewer/components/LogsModal.js';

describe('parseLogLine with source', () => {
  it('extracts source when present', () => {
    const p = parseLogLine('[2026-06-29 00:00:00.000] [WARN ] [DB    ] [worker] slow');
    expect(p.component).toBe('DB');
    expect(p.source).toBe('worker');
    expect(p.message).toBe('slow');
  });
  it('still parses legacy lines without source', () => {
    const p = parseLogLine('[2026-06-29 00:00:00.000] [INFO ] [SYSTEM] boot');
    expect(p.component).toBe('SYSTEM');
    expect(p.source).toBeUndefined();
    expect(p.message).toBe('boot');
  });
});
