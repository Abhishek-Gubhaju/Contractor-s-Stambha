// @vitest-environment jsdom
// Document store: validation, metadata round-trip, legacy fallback, cleanup.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ATTACHMENT_META_KEY,
  ENTRY_DOCUMENTS_KEY,
  MAX_ATTACHMENT_BYTES,
  documentsForEntry,
  linkDocument,
  mimeFromDataUrl,
  dataUrlBytes,
  removeDocument,
  storeDocument,
  validateAttachment,
} from './attachmentService';
import { ATTACH_KEY, readAttachment, saveAttachment } from './ledgerService';
import { keyFor } from './projectScope';

/** Stores are project-scoped; tests read the same physical key the app uses. */
const stored = (key: string) => localStorage.getItem(keyFor(key));

const PNG = 'data:image/png;base64,AAAA';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

const image = (patch: Record<string, any> = {}) => ({ fileName: 'bill-photo.png', mimeType: 'image/png', dataUrl: PNG, sizeBytes: 3, ...patch });

beforeEach(() => localStorage.clear());

describe('validation', () => {
  it('accepts images and PDFs with their metadata', () => {
    const meta = validateAttachment({ fileName: 'scan.pdf', mimeType: 'application/pdf', dataUrl: PDF });
    expect(meta.mimeType).toBe('application/pdf');
    expect(meta.fileName).toBe('scan.pdf');
    expect(meta.checksum).toMatch(/^[0-9a-f]{8}$/);
    expect(meta.sizeBytes).toBe(dataUrlBytes(PDF));
  });

  it('rejects anything that is not an image or PDF', () => {
    expect(() => validateAttachment({ fileName: 'x.html', mimeType: 'text/html', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }))
      .toThrow(/Only images/i);
    expect(() => validateAttachment({ fileName: 'x.js', mimeType: 'application/javascript', dataUrl: 'data:application/javascript;base64,YQ==' }))
      .toThrow(/Only images/i);
  });

  it('rejects an oversized file and unreadable data', () => {
    expect(() => validateAttachment(image({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }))).toThrow(/under/i);
    expect(() => validateAttachment({ fileName: 'x.png', mimeType: 'image/png', dataUrl: '' })).toThrow(/could not be read/i);
  });

  it('reads the mime type back out of a data URL', () => {
    expect(mimeFromDataUrl(PDF)).toBe('application/pdf');
    expect(mimeFromDataUrl('')).toBe('');
  });
});

describe('store round-trip', () => {
  it('stores the file, its metadata and the entry link', () => {
    const { path, meta } = storeDocument(image());
    expect(path).toContain('data/ledger/attachments/');
    expect(readAttachment(path)).toBe(PNG);
    expect(meta.fileName).toBe('bill-photo.png');

    const metaStore = JSON.parse(stored(ATTACHMENT_META_KEY) || '{}');
    expect(metaStore[path]).toMatchObject({ fileName: 'bill-photo.png', mimeType: 'image/png', sizeBytes: 3 });

    linkDocument('E-1', path);
    const docs = documentsForEntry({ id: 'E-1' });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ path, fileName: 'bill-photo.png', mimeType: 'image/png', available: true });
    expect(docs[0].dataUrl).toBe(PNG);
  });

  it('does not duplicate a link', () => {
    const { path } = storeDocument(image());
    linkDocument('E-1', path);
    linkDocument('E-1', path);
    expect(documentsForEntry({ id: 'E-1' })).toHaveLength(1);
  });
});

describe('legacy records', () => {
  it('reads an entry that only has the old attachment path', () => {
    const path = saveAttachment('old-scan.jpg', 'data:image/jpeg;base64,AAAA');
    const docs = documentsForEntry({ id: 'OLD-1', attachment: path });
    expect(docs).toHaveLength(1);
    expect(docs[0].fileName).toBe('old-scan.jpg');
    expect(docs[0].mimeType).toBe('image/jpeg');
    expect(docs[0].available).toBe(true);
    expect(docs[0].checksum).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reports a missing file instead of inventing one', () => {
    const docs = documentsForEntry({ id: 'OLD-2', attachment: 'data/ledger/attachments/gone.png' });
    expect(docs).toHaveLength(1);
    expect(docs[0].available).toBe(false);
    expect(docs[0].dataUrl).toBe('');
  });

  it('returns nothing for an entry without documents', () => {
    expect(documentsForEntry({ id: 'E-9' })).toEqual([]);
    expect(documentsForEntry(null)).toEqual([]);
  });
});

describe('cleanup', () => {
  it('removes the blob, metadata and links together', () => {
    const { path } = storeDocument(image());
    linkDocument('E-1', path);
    removeDocument(path);

    expect(readAttachment(path)).toBeNull();
    expect(JSON.parse(stored(ATTACH_KEY) || '{}')[path]).toBeUndefined();
    expect(JSON.parse(stored(ATTACHMENT_META_KEY) || '{}')[path]).toBeUndefined();
    expect(JSON.parse(stored(ENTRY_DOCUMENTS_KEY) || '[]')).toHaveLength(0);
    expect(documentsForEntry({ id: 'E-1' })).toEqual([]);
  });
});
