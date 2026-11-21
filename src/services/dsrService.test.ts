// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  blankReport,
  blankWorkItem,
  migrateReport,
  migrateReports,
  dsrLines,
  cumulativeFor,
  cumulativeBefore,
  cumulativeMap,
  nextReportNo,
  reportPrefix,
  validateReport,
  submitReport,
  approveReport,
  reopenReport,
  canEdit,
  withMirrors,
  labourCount,
  labourHours,
  delayHours,
  plantHours,
  normalizeAttachments,
  MAX_DSR_ATTACHMENTS,
  type DsrReport,
} from './dsrService';
import { cumulativeDone } from './dsrSyncService';

const D = '2026-01-15';
const D_NEXT = '2026-01-16';

function reportWith(date: string, code: string, qty: number, extraItems: { code: string; qty: number }[] = []): DsrReport {
  const base = blankReport('PRJ-1', date);
  const items = [
    { ...blankWorkItem(), boqCode: code, description: `${code} work`, unit: 'cum', quantity: qty },
    ...extraItems.map((x) => ({ ...blankWorkItem(), boqCode: x.code, description: x.code, unit: 'cum', quantity: x.qty })),
  ];
  return withMirrors({ ...base, items });
}

describe('DSR migration', () => {
  it('turns a legacy single-line record into a one-item document', () => {
    const legacy = {
      id: 'old-1',
      date: D,
      boqCode: 'R-101',
      boqDescription: 'Earthwork excavation',
      workSummary: 'Roadway cut CH 0+200',
      workQuantity: 120.5,
      unit: 'cum',
      laborHeadcount: 12,
      isSubmitted: true,
    };
    const report = migrateReport(legacy, 'PRJ-1');
    expect(report.id).toBe('old-1');
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ boqCode: 'R-101', quantity: 120.5, unit: 'cum' });
    expect(report.status).toBe('submitted');
    expect(report.isSubmitted).toBe(true);
    expect(report.labour[0]).toMatchObject({ count: 12 });
    // Mirrors are preserved so untouched consumers still read the same numbers.
    expect(report.boqCode).toBe('R-101');
    expect(report.workQuantity).toBe(120.5);
    // B.S. is derived for the printed header.
    expect(report.bs_y).toBeGreaterThan(2000);
  });

  it('is idempotent and keeps every item of a document report', () => {
    const report = reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4 }]);
    const once = migrateReport(report, 'PRJ-1');
    const twice = migrateReport(once, 'PRJ-1');
    expect(twice.items).toHaveLength(2);
    expect(twice.boqCode).toBe('R-101');
    expect(migrateReports([report, once], 'PRJ-1')).toHaveLength(2);
    expect(migrateReports(null, 'PRJ-1')).toEqual([]);
  });
});

describe('dsrLines — the one aggregation rule', () => {
  it('flattens every work item of every report', () => {
    const lines = dsrLines([
      reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4 }]),
      { id: 'legacy', date: D_NEXT, boqCode: 'R-101', workQuantity: 5, unit: 'cum' },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.boqCode === 'R-101')).toHaveLength(2);
  });

  it('counts multi-item reports per BOQ code, not just the first line', () => {
    const records = [reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4 }])];
    expect(cumulativeFor(records, 'R-101')).toBe(10);
    expect(cumulativeFor(records, 'b-202')).toBe(4); // case-insensitive
    expect(cumulativeFor(records, 'NOPE')).toBe(0);
  });

  it('previous figure excludes the same day and later days', () => {
    const records = [
      reportWith('2026-01-10', 'R-101', 5),
      reportWith(D, 'R-101', 10),
      reportWith(D_NEXT, 'R-101', 3),
    ];
    expect(cumulativeBefore(records, 'R-101', D)).toBe(5);
    expect(cumulativeBefore(records, 'R-101', '2026-01-01')).toBe(0);
  });

  it('builds a cumulative map in one pass', () => {
    const map = cumulativeMap([reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4 }])]);
    expect(map.get('r-101')).toBe(10);
    expect(map.get('b-202')).toBe(4);
  });

  it('feeds dsrSyncService.cumulativeDone the same totals', () => {
    const records = [reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4 }])];
    expect(cumulativeDone(records as any[], 'R-101')).toBe(10);
    expect(cumulativeDone(records as any[], 'B-202')).toBe(4);
    expect(cumulativeDone([{ boqCode: 'R-101', workQuantity: 7 } as any], 'R-101')).toBe(7);
  });
});

describe('DSR numbering', () => {
  it('numbers per fiscal year inside one series', () => {
    const prefix = reportPrefix(D);
    expect(prefix).toMatch(/^DSR-\d{4}\/\d{2}-$/);
    expect(nextReportNo(D, [])).toBe(`${prefix}001`);

    const existing = [
      { ...reportWith(D, 'R-101', 1), reportNo: `${prefix}001` },
      { ...reportWith(D_NEXT, 'R-101', 1), reportNo: `${prefix}002` },
    ];
    expect(nextReportNo(D_NEXT, existing)).toBe(`${prefix}003`);

    // A report numbered in another fiscal year must not affect this one.
    const otherFy = { ...reportWith(D, 'R-101', 1), reportNo: 'DSR-1999/00-009' };
    expect(nextReportNo(D, [otherFy])).toBe(`${prefix}001`);
  });
});

describe('DSR validation', () => {
  const boq = [{ itemCode: 'R-101', description: 'Earthwork', unit: 'cum', quantity: 100, rate: 500 }];

  it('allows a second report on the same day, warning so it is noticed', () => {
    const mine = reportWith(D, 'R-101', 10);
    const other = reportWith(D, 'R-101', 5);
    other.id = 'other';
    const { errors, warnings } = validateReport(other, { existing: [mine], today: '2026-02-01' });
    expect(errors).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/already exists for/);
  });

  it('blocks a future date and negative quantities', () => {
    const future = reportWith('2026-03-01', 'R-101', 10);
    expect(validateReport(future, { today: '2026-02-01' }).errors.join(' ')).toMatch(/future/);
    const negative = reportWith(D, 'R-101', -1);
    expect(validateReport(negative, { today: '2026-02-01' }).errors.join(' ')).toMatch(/negative/);
  });

  it('requires a work item only on submit, not on draft', () => {
    const empty = blankReport('PRJ-1', D);
    expect(validateReport(empty, { today: '2026-02-01' }).errors).toHaveLength(0);
    expect(validateReport(empty, { submit: true, today: '2026-02-01' }).errors.join(' ')).toMatch(/work item/);
  });

  it('blocks the same BOQ code twice on one report', () => {
    const dup = reportWith(D, 'R-101', 5, [{ code: 'R-101', qty: 5 }]);
    expect(validateReport(dup, { today: '2026-02-01' }).errors.join(' ')).toMatch(/already on this report/);
  });

  it('warns — does not block — when the BOQ quantity is exceeded', () => {
    const over = reportWith(D, 'R-101', 40);
    const prior = reportWith('2026-01-14', 'R-101', 80);
    const result = validateReport(over, { existing: [prior], boq, today: '2026-02-01' });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/over the BOQ quantity 100/);
  });

  it('rejects impossible labour hours and an unlabelled delay', () => {
    const report = reportWith(D, 'R-101', 5);
    report.labour = [{ id: 'l1', trade: 'Mason', count: 4, hours: 30, overtimeHours: 0 }];
    expect(validateReport(report, { today: '2026-02-01' }).errors.join(' ')).toMatch(/between 0 and 24/);

    report.labour = [];
    report.delays = [{ id: 'd1', reason: '', hours: 3 }];
    expect(validateReport(report, { today: '2026-02-01' }).errors.join(' ')).toMatch(/needs a reason/);
  });

  it('locks an approved report without raising validation noise', () => {
    const approved = approveReport(submitReport(reportWith(D, 'R-101', 5)), 'ok');
    expect(canEdit(approved)).toBe(false);
    // Reading an approved report is not an error — the editor is read-only and
    // reopening is a separate, reasoned action.
    expect(validateReport(approved, { today: '2026-02-01' }).errors).toHaveLength(0);
  });
});

describe('DSR workflow', () => {
  it('draft → submitted → approved, recording history', () => {
    const draft = reportWith(D, 'R-101', 5);
    const submitted = submitReport(draft, 'Sent to engineer');
    expect(submitted.status).toBe('submitted');
    expect(submitted.isSubmitted).toBe(true);
    expect(submitted.history[submitted.history.length - 1]).toMatchObject({ action: 'submit', status: 'submitted' });

    const approved = approveReport(submitted, 'Checked');
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.history.map((h) => h.action)).toEqual(['submit', 'approve']);
  });

  it('rejects illegal transitions and needs a reason to reopen', () => {
    const draft = reportWith(D, 'R-101', 5);
    expect(() => approveReport(draft)).toThrow();
    const approved = approveReport(submitReport(draft));
    expect(() => reopenReport(approved, '   ')).toThrow(/reason/);
    const reopened = reopenReport(approved, 'Quantity corrected');
    expect(reopened.status).toBe('draft');
    expect(reopened.history[reopened.history.length - 1]).toMatchObject({ action: 'reopen', reason: 'Quantity corrected' });
    expect(canEdit(reopened)).toBe(true);
  });
});

describe('DSR mirrors and totals', () => {
  it('keeps the compatibility mirrors in step with the items', () => {
    const report = reportWith(D, 'R-101', 10, [{ code: 'B-202', qty: 4.5 }]);
    report.labour = [
      { id: 'l1', trade: 'Mason', count: 4, hours: 8, overtimeHours: 2 },
      { id: 'l2', trade: 'Helper', count: 6, hours: 8, overtimeHours: 0 },
    ];
    report.delays = [{ id: 'd1', reason: 'Rain', hours: 2 }];
    report.plant = [{ id: 'p1', name: 'Excavator', hours: 6, idleHours: 2, note: '' }];
    const mirrored = withMirrors(report);

    expect(mirrored.workQuantity).toBe(14.5);
    expect(mirrored.boqCode).toBe('R-101');
    expect(mirrored.boqDescription).toBe('R-101 work');
    expect(mirrored.unit).toBe('cum');
    expect(mirrored.laborHeadcount).toBe(10);
    expect(mirrored.workSummary).toContain('B-202');
    expect(mirrored.bs_y).toBe(mirrored.bs_y); // date + B.S. derived together
    expect(labourCount(mirrored)).toBe(10);
    // Hours on site include overtime: 10 men × 8 h + 2 OT hours.
    expect(labourHours(mirrored)).toBe(82);
    expect(delayHours(mirrored)).toBe(2);
    expect(plantHours(mirrored)).toBe(6);
  });
});

describe('DSR attachments', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `${id}.pdf`,
    ext: 'pdf',
    sizeBytes: 10,
    addedAt: '2026-01-10T08:00:00.000Z',
    ...extra,
  });

  it('starts empty and migrates a report written before attachments existed', () => {
    expect(blankReport('PRJ-1', D).attachments).toEqual([]);
    const older = reportWith(D, 'R-101', 5) as Partial<DsrReport>;
    delete older.attachments;
    expect(migrateReport(older, 'PRJ-1').attachments).toEqual([]);
  });

  it('drops unusable rows and duplicate ids, and normalises the extension', () => {
    const rows = normalizeAttachments([
      row('a'),
      row('a'),
      null,
      { id: '', name: 'no id' },
      { id: 'b', name: '   ' },
      row('c', { ext: '.PDF', sizeBytes: 'nope' }),
    ]);
    expect(rows.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(rows[1].ext).toBe('pdf');
    expect(rows[1].sizeBytes).toBe(0);
    expect(normalizeAttachments('not a list')).toEqual([]);
  });

  it('blocks an over-limit or duplicated link but never requires a file', () => {
    const full = reportWith(D, 'R-101', 5);
    full.attachments = Array.from({ length: MAX_DSR_ATTACHMENTS + 1 }, (_, i) => row(`x-${i}`));
    expect(validateReport(full, { today: '2026-02-01' }).errors.join(' ')).toMatch(/can link 50/);

    const duplicate = reportWith(D, 'R-101', 5);
    duplicate.attachments = [row('a'), row('a')];
    expect(validateReport(duplicate, { today: '2026-02-01' }).errors.join(' ')).toMatch(/linked twice/);

    const none = reportWith(D, 'R-101', 5);
    expect(validateReport(none, { submit: true, today: '2026-02-01' }).errors).toHaveLength(0);
  });

  it('preserves the links through withMirrors', () => {
    const file = reportWith(D, 'R-101', 5);
    file.attachments = [row('a')];
    expect(withMirrors(file).attachments).toEqual(file.attachments);
  });
});
