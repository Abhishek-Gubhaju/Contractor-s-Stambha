// @vitest-environment jsdom
// Staff codes and staff file intake.
import { describe, it, expect } from 'vitest';
import { nextStaffCode, readFileAsDataUrl, formatBytes, mimeOfDataUrl, MAX_DOC_BYTES, MAX_PHOTO_BYTES } from './staffService';

describe('nextStaffCode', () => {
  it('starts the series at STF-001', () => {
    expect(nextStaffCode([])).toBe('STF-001');
    expect(nextStaffCode([{ code: '' }, {}])).toBe('STF-001');
  });

  it('continues after the highest number on file', () => {
    expect(nextStaffCode([{ code: 'STF-001' }, { code: 'STF-007' }, { code: 'STF-003' }])).toBe('STF-008');
  });

  it('counts codes of any prefix and never reuses a number', () => {
    expect(nextStaffCode([{ code: 'EMP-12' }])).toBe('STF-013');
    expect(nextStaffCode([{ code: 'STF-999' }])).toBe('STF-1000');
  });

  it('ignores codes without a trailing number', () => {
    expect(nextStaffCode([{ code: 'STF-' }, { code: 'TEMP' }])).toBe('STF-001');
  });
});

describe('staff files', () => {
  it('reads a picked file into a data URL with its type and size', async () => {
    const file = new File(['hello'], 'citizenship.txt', { type: 'text/plain' });
    const read = await readFileAsDataUrl(file);
    expect(read.fileName).toBe('citizenship.txt');
    expect(read.mimeType).toBe('text/plain');
    expect(read.sizeBytes).toBe(5);
    expect(read.dataUrl.startsWith('data:text/plain;base64,')).toBe(true);
  });

  it('formats sizes and reads the mime type back out of a data URL', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(mimeOfDataUrl('data:image/png;base64,AAAA')).toBe('image/png');
    expect(mimeOfDataUrl('')).toBe('');
    expect(MAX_DOC_BYTES).toBeGreaterThan(MAX_PHOTO_BYTES);
  });
});
