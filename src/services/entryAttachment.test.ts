// @vitest-environment jsdom
// Attachments ride inside the entry's atomic write: stored, linked, rolled back
// and cleaned up together with it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  attachDocumentToEntry,
  editEntry,
  saveEntry,
  saveSupplierBill,
  allEntries,
  entryById,
  lockPeriod,
} from './booksService';
import { ATTACHMENT_META_KEY, ENTRY_DOCUMENTS_KEY, documentsForEntry } from './attachmentService';
import { ATTACH_KEY, readAttachment } from './ledgerService';
import { keyFor } from './projectScope';

/** Stores are project-scoped; tests read the same physical key the app uses. */
const stored = (key: string) => localStorage.getItem(keyFor(key));
const isBase = (key: string, base: string) => key.split('::')[0] === base;

const D = '2025-04-20'; // Baisakh 2082
const PNG = (tag: string) => `data:image/png;base64,${tag}`;
const file = (tag = 'AAAA', name = 'bill.png') => ({ fileName: name, mimeType: 'image/png', dataUrl: PNG(tag), sizeBytes: 3 });

const billForm = { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 5000, ref: 'B-1' };

const attachmentCount = () => Object.keys(JSON.parse(stored(ATTACH_KEY) || '{}')).length;
const metaCount = () => Object.keys(JSON.parse(stored(ATTACHMENT_META_KEY) || '{}')).length;
const linkCount = () => JSON.parse(stored(ENTRY_DOCUMENTS_KEY) || '[]').length;

beforeEach(() => localStorage.clear());

describe('saving with an attachment', () => {
  it('persists the entry, the file and the link together', () => {
    const entry = saveEntry('supplier-bill', billForm, { attachment_file: file('AAAA', 'bill-scan.png') });

    expect(entry.attachment).toContain('data/ledger/attachments/');
    expect(readAttachment(entry.attachment)).toBe(PNG('AAAA'));
    const docs = documentsForEntry(entry);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ fileName: 'bill-scan.png', mimeType: 'image/png', available: true });
    expect(linkCount()).toBe(1);
  });

  it('leaves nothing behind when the entry save fails', () => {
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (isBase(key, 'contractoros_entry_lines')) throw new Error('disk full');
      return original.call(this, key, value);
    });

    expect(() => saveEntry('supplier-bill', billForm, { attachment_file: file() })).toThrow(/disk full/);
    spy.mockRestore();

    expect(allEntries()).toHaveLength(0);
    expect(attachmentCount()).toBe(0); // no orphan file
    expect(metaCount()).toBe(0);
    expect(linkCount()).toBe(0);
  });

  it('refuses a document the store does not allow, storing nothing', () => {
    expect(() =>
      saveEntry('supplier-bill', billForm, { attachment_file: { fileName: 'x.html', mimeType: 'text/html', dataUrl: 'data:text/html;base64,PGI+' } })
    ).toThrow(/Only images/i);
    expect(allEntries()).toHaveLength(0);
    expect(attachmentCount()).toBe(0);
  });

  it('respects a locked period', () => {
    lockPeriod(2082, 1, 'closed month');
    expect(() => saveEntry('supplier-bill', billForm, { attachment_file: file() })).toThrow(/locked/i);
    expect(attachmentCount()).toBe(0);
  });

  it('rolls the document back when a paid-now bill pair fails', () => {
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (isBase(key, 'contractoros_entries') && String(value).includes('"payment-supplier"')) throw new Error('disk full');
      return original.call(this, key, value);
    });

    expect(() =>
      saveSupplierBill({ ...billForm, paid_now: true, pay_method: 'cash' }, { attachment_file: file() })
    ).toThrow(/disk full/);
    spy.mockRestore();

    expect(allEntries()).toHaveLength(0);
    expect(attachmentCount()).toBe(0);
    expect(metaCount()).toBe(0);
    expect(linkCount()).toBe(0);
  });
});

describe('editing a document', () => {
  it('replaces the file and deletes the old one', () => {
    const entry = saveEntry('supplier-bill', billForm, { attachment_file: file('AAAA', 'first.png') });
    const oldPath = entry.attachment;

    const updated = editEntry(entry.id, 'supplier-bill', billForm, 'wrong scan', { attachment_file: file('BBBB', 'second.png') });

    expect(updated.attachment).not.toBe(oldPath);
    expect(readAttachment(oldPath)).toBeNull();
    expect(readAttachment(updated.attachment)).toBe(PNG('BBBB'));
    const docs = documentsForEntry(updated);
    expect(docs).toHaveLength(1);
    expect(docs[0].fileName).toBe('second.png');
    expect(linkCount()).toBe(1);
  });

  it('removes the document without touching the posting', () => {
    const entry = saveEntry('supplier-bill', billForm, { attachment_file: file() });
    const oldPath = entry.attachment;

    const updated = editEntry(entry.id, 'supplier-bill', billForm, 'scan was wrong', { remove_attachment: true });

    expect(updated.attachment).toBe('');
    expect(readAttachment(oldPath)).toBeNull();
    expect(documentsForEntry(updated)).toHaveLength(0);
    expect(linkCount()).toBe(0);
    // The accounting side is unchanged.
    expect(entryById(entry.id)!.id).toBe(entry.id);
  });

  it('keeps the current document when the edit does not touch it', () => {
    const entry = saveEntry('supplier-bill', billForm, { attachment_file: file() });
    const updated = editEntry(entry.id, 'supplier-bill', { ...billForm, ref: 'B-1A' }, 'ref fixed');
    expect(updated.attachment).toBe(entry.attachment);
    expect(readAttachment(entry.attachment)).not.toBeNull();
  });

  it('does not leave a file behind when the edit is rejected', () => {
    const { bill } = saveSupplierBill({ ...billForm, paid_now: true, pay_method: 'cash' });
    const before = attachmentCount();

    expect(() =>
      editEntry(bill.id, 'supplier-bill', { ...billForm, tds_rate: 1.5 }, 'add tds', { attachment_file: file() })
    ).toThrow(/TDS/);

    expect(attachmentCount()).toBe(before);
    expect(documentsForEntry(entryById(bill.id)!)).toHaveLength(0);
  });

  it('does not store a rejected replacement', () => {
    const entry = saveEntry('supplier-bill', billForm, { attachment_file: file() });
    expect(() =>
      editEntry(entry.id, 'supplier-bill', billForm, 'bad file', { attachment_file: { fileName: 'x.exe', mimeType: 'application/octet-stream', dataUrl: 'data:application/octet-stream;base64,QQ==' } })
    ).toThrow(/Only images/i);
    expect(attachmentCount()).toBe(1);
    expect(documentsForEntry(entryById(entry.id)!)).toHaveLength(1);
  });
});

describe('entries posted by another service', () => {
  it('attaches a document to an existing entry and links it', () => {
    const entry = saveEntry('worker-advance', { date: D, worker_id: 'w1', worker_name: 'Ram Thapa', amount: 1000, method: 'cash' });
    const updated = attachDocumentToEntry(entry.id, file('CCCC', 'advance-slip.png'));

    expect(updated.attachment).toBeTruthy();
    expect(documentsForEntry(entryById(entry.id)!)).toHaveLength(1);
    expect(readAttachment(updated.attachment)).toBe(PNG('CCCC'));
  });
});
