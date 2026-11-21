// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('../services/auth/authService', () => ({
  activeUser: () => ({ id: 'usr-test', username: 'tester', displayName: 'Tester' }),
}));

vi.mock('../components/ui/DialogHost', () => ({
  destroyDialog: vi.fn(async () => true),
  confirmDialog: vi.fn(async () => true),
  notify: (...args: unknown[]) => notifyMock(...args),
  DialogHost: () => null,
}));

// A controllable upload lets a test resolve the file AFTER the supervisor has
// typed — the exact race the functional update in DSRPage exists to survive.
const { uploadControl, retargetCalls, notifyMock } = vi.hoisted(() => ({
  uploadControl: { current: null as null | ((input: unknown) => Promise<unknown>) },
  retargetCalls: [] as string[],
  notifyMock: vi.fn(),
}));

vi.mock('../services/dsrAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dsrAttachments')>();
  return {
    ...actual,
    uploadDsrAttachments: (input: Parameters<typeof actual.uploadDsrAttachments>[0]) =>
      uploadControl.current
        ? (uploadControl.current(input) as ReturnType<typeof actual.uploadDsrAttachments>)
        : actual.uploadDsrAttachments(input),
    retargetDsrAttachments: (
      report: Parameters<typeof actual.retargetDsrAttachments>[0],
      ctx: Parameters<typeof actual.retargetDsrAttachments>[1]
    ) => {
      retargetCalls.push(report.date);
      return actual.retargetDsrAttachments(report, ctx);
    },
  };
});

import DSRPage from './DSR';
import { getCurrentDateInTimezone } from '../utils';
import { blankReport, blankWorkItem, reportPrefix, withMirrors, type DsrReport } from '../services/dsrService';
import { memoryVault, resetMemoryVault } from '../services/vault/memoryVault';
import { documentById } from '../services/vault/vaultService';
import { dsrFolderChain, uploadDsrAttachments } from '../services/dsrAttachments';

const TZ = 'Asia/Kathmandu';

function report(overrides: Partial<DsrReport> = {}): DsrReport {
  const base = blankReport('PRJ-001', getCurrentDateInTimezone(TZ));
  return withMirrors({
    ...base,
    reportNo: 'DSR-2082/83-001',
    status: 'submitted',
    isSubmitted: true,
    items: [
      { ...blankWorkItem(), boqCode: 'R-101', description: 'Earthwork excavation', unit: 'cum', quantity: 120, location: 'CH 0+250' },
      { ...blankWorkItem(), boqCode: 'B-202', description: 'PCC M15', unit: 'cum', quantity: 8, location: 'Pier 3' },
    ],
    labour: [{ id: 'l1', trade: 'Mason', count: 4, hours: 8, overtimeHours: 0 }],
    ...overrides,
  });
}

const props = (dsrData: any[] = []) => ({
  dsrData,
  setDsrData: vi.fn(),
  boqData: [
    {
      id: 's1',
      code: 'R',
      description: 'Road works',
      children: [
        { itemCode: 'R-101', description: 'Earthwork excavation', unit: 'cum', estimatedQuantity: 1000, rate: 500 },
        { itemCode: 'B-202', description: 'PCC M15', unit: 'cum', estimatedQuantity: 200, rate: 9000 },
      ],
    },
  ],
  laborData: [{ id: 'w1', trade: 'Mason', status: 'present' }],
  timezone: TZ,
});

describe('DSR register', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMemoryVault();
    uploadControl.current = null;
    retargetCalls.length = 0;
    notifyMock.mockClear();
  });

  it('lists a multi-item report with its items, number and status', () => {
    render(<DSRPage {...props([report()])} />);
    expect(screen.getByText('DSR-2082/83-001')).toBeTruthy();
    expect(screen.getByText(/R-101 · B-202/)).toBeTruthy();
    expect(screen.getByText('submitted')).toBeTruthy();
  });

  it('saves a new report as a numbered draft from the editor', () => {
    const p = props();
    render(<DSRPage {...p} />);
    fireEvent.click(screen.getByTestId('dsr-new'));

    fireEvent.change(screen.getByLabelText('Work item 1 BOQ code'), { target: { value: 'R-101' } });
    fireEvent.change(screen.getByLabelText('Work item 1 quantity'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('dsr-save-draft'));

    expect(p.setDsrData).toHaveBeenCalled();
    const saved = p.setDsrData.mock.calls[0][0] as DsrReport[];
    expect(saved).toHaveLength(1);
    expect(saved[0].reportNo).toMatch(/^DSR-\d{4}\/\d{2}-001$/);
    expect(saved[0].status).toBe('draft');
    expect(saved[0].items[0]).toMatchObject({ boqCode: 'R-101', quantity: 25, unit: 'cum' });
    // Unit and description come from the BOQ, not from memory.
    expect(saved[0].items[0].description).toBe('Earthwork excavation');
  });

  it('refuses to submit a report with no work item', () => {
    const p = props();
    render(<DSRPage {...p} />);
    fireEvent.click(screen.getByTestId('dsr-new'));
    fireEvent.click(screen.getByTestId('dsr-submit'));
    expect(p.setDsrData).not.toHaveBeenCalled();
  });

  it('prints the open report sheet, not the register around it', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<DSRPage {...props([report()])} />);

    fireEvent.click(screen.getByLabelText('Print DSR-2082/83-001'));
    fireEvent.click(screen.getByTestId('dsr-print'));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const printed = document.getElementById('print-root');
    expect(printed?.textContent).toContain('DSR-2082/83-001');
    expect(printed?.textContent).toContain('R-101');

    window.dispatchEvent(new Event('afterprint'));
    printSpy.mockRestore();
  });

  it('creates a second report for the same date instead of reopening the first', () => {
    // Same fiscal-year series, so the second entry must take the next number.
    const prefix = reportPrefix(getCurrentDateInTimezone(TZ));
    const existing = report({ reportNo: `${prefix}001` });
    const p = props([existing]);
    render(<DSRPage {...p} />);
    fireEvent.click(screen.getByTestId('dsr-new'));

    // A fresh, empty form — not the existing report's lines.
    expect(screen.queryByDisplayValue('R-101')).toBeNull();
    fireEvent.change(screen.getByLabelText('Work item 1 BOQ code'), { target: { value: 'B-202' } });
    fireEvent.change(screen.getByLabelText('Work item 1 quantity'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('dsr-save-draft'));

    const saved = p.setDsrData.mock.calls[0][0] as DsrReport[];
    expect(saved).toHaveLength(2);
    const added = saved.find((r) => r.id !== existing.id)!;
    expect(added.reportNo).toBe(`${prefix}002`);
    expect(added.items[0]).toMatchObject({ boqCode: 'B-202', quantity: 6 });
  });

  it('still opens a new entry after the day\'s report has been approved', () => {
    // The reported bug: approving today's report left "New DSR" reopening the
    // locked document, so no further entries could be made.
    const prefix = reportPrefix(getCurrentDateInTimezone(TZ));
    const approved = report({
      reportNo: `${prefix}001`,
      status: 'approved',
      approvedAt: '2026-02-01T10:00:00.000Z',
    });
    const p = props([approved]);
    render(<DSRPage {...p} />);

    fireEvent.click(screen.getByTestId('dsr-new'));
    fireEvent.change(screen.getByLabelText('Work item 1 BOQ code'), { target: { value: 'R-101' } });
    fireEvent.change(screen.getByLabelText('Work item 1 quantity'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('dsr-submit'));

    const saved = p.setDsrData.mock.calls[0][0] as DsrReport[];
    expect(saved).toHaveLength(2);
    const added = saved.find((r) => r.id !== approved.id)!;
    expect(added.status).toBe('submitted');
    expect(added.reportNo).toBe(`${prefix}002`);
    // The approved document is untouched.
    expect(saved.find((r) => r.id === approved.id)).toMatchObject({ status: 'approved', items: approved.items });
  });

  it('shows a paperclip count and prints the attached file names', () => {
    const withFiles = report({
      attachments: [
        {
          id: 'doc-1',
          name: 'cube-report.pdf',
          ext: 'pdf',
          sizeBytes: 2048,
          addedAt: '2026-01-10T08:00:00.000Z',
        },
      ],
    });
    render(<DSRPage {...props([withFiles])} />);
    expect(screen.getByTestId(`dsr-file-count-${withFiles.id}`).textContent).toContain('1');

    fireEvent.click(screen.getByLabelText('Print DSR-2082/83-001'));
    expect(screen.getByTestId('dsr-sheet-attachments').textContent).toContain('cube-report.pdf');
  });

  it('offers a photos & files section in the editor', () => {
    render(<DSRPage {...props()} />);
    fireEvent.click(screen.getByTestId('dsr-new'));
    fireEvent.click(screen.getByTestId('dsr-section-files'));
    expect(screen.getByTestId('dsr-attachments')).toBeTruthy();
  });

  it('keeps text typed after an upload started when the upload resolves later', async () => {
    let finish: ((value: unknown) => void) | undefined;
    uploadControl.current = () =>
      new Promise((resolve) => {
        finish = resolve;
      });

    const p = props();
    render(<DSRPage {...p} />);
    fireEvent.click(screen.getByTestId('dsr-new'));
    fireEvent.click(screen.getByTestId('dsr-section-files'));
    fireEvent.change(screen.getByTestId('dsr-attach-input'), {
      target: { files: [new File(['abc'], 'slab.pdf', { type: 'application/pdf' })] },
    });
    expect(finish).toBeTruthy();

    // The file is still uploading; the site supervisor keeps typing.
    fireEvent.change(screen.getByLabelText('Prepared by'), {
      target: { value: 'Ram Bahadur' },
    });

    await act(async () => {
      finish!({
        added: [
          {
            id: 'doc-late',
            name: 'slab.pdf',
            ext: 'pdf',
            sizeBytes: 3,
            addedAt: '2026-01-10T08:00:00.000Z',
          },
        ],
        failed: [],
      });
    });

    // The link arrived without discarding the typed name.
    expect(await screen.findByTestId('dsr-attach-remove-doc-late')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('dsr-save-draft'));
    });

    const saved = p.setDsrData.mock.calls[0][0] as DsrReport[];
    expect(saved).toHaveLength(1);
    expect(saved[0].preparedBy).toBe('Ram Bahadur');
    expect(saved[0].attachments).toHaveLength(1);
  });

  it('does not retarget files when the stored report date did not change', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [new File(['abc'], 'slab.pdf', { type: 'application/pdf' })],
      report: report({ date: '2026-01-10', attachments: [] }),
      ctx: { userId: 'usr-test', projectId: 'PRJ-001' },
      storage: memoryVault,
    });
    const p = props([report({ date: '2026-01-10', attachments: uploaded.added })]);
    render(<DSRPage {...p} />);

    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-01' } });
    fireEvent.click(screen.getByLabelText('Edit DSR-2082/83-001'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('dsr-save-draft'));
    });

    expect(p.setDsrData).toHaveBeenCalledTimes(1);
    expect(retargetCalls).toHaveLength(0);
  });

  it('locks an approved report in the editor and blocks saving', () => {
    const approved = report({
      status: 'approved',
      approvedAt: '2026-02-01T10:00:00.000Z',
    });
    render(<DSRPage {...props([approved])} />);
    const openButton = screen.getByLabelText('View DSR-2082/83-001');
    // The row's action becomes a read-only "View" for an approved report.
    expect(openButton.getAttribute('title')).toBe('View');
    fireEvent.click(openButton);

    expect((screen.getByLabelText('Report date') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('dsr-add-work') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('dsr-save-draft') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/approved reports are locked/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('dsr-section-files'));
    expect((screen.getByTestId('dsr-attach-add') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('dsr-attach-photo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the File Vault on a linked file', () => {
    const onNavigate = vi.fn();
    const withFiles = report({
      attachments: [
        { id: 'doc-1', name: 'cube-report.pdf', ext: 'pdf', sizeBytes: 2048, addedAt: '2026-01-10T08:00:00.000Z' },
      ],
    });
    render(<DSRPage {...props([withFiles])} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByLabelText('Edit DSR-2082/83-001'));
    fireEvent.click(screen.getByTestId('dsr-section-files'));
    fireEvent.click(screen.getByTestId('dsr-attach-open-doc-1'));

    expect(onNavigate).toHaveBeenCalledWith('vault');
    expect(localStorage.getItem('contractoros_vault_focus')).toContain('doc-1');
  });

  it('finds a report by the name of an attached file', () => {
    render(
      <DSRPage
        {...props([
          report({
            attachments: [
              { id: 'doc-1', name: 'cube-report.pdf', ext: 'pdf', sizeBytes: 1, addedAt: '2026-01-10T08:00:00.000Z' },
            ],
          }),
        ])}
      />
    );
    const search = screen.getByLabelText('Search reports');
    fireEvent.change(search, { target: { value: 'cube-report' } });
    expect(screen.getByText('DSR-2082/83-001')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'nothing-matches' } });
    expect(screen.queryByText('DSR-2082/83-001')).toBeNull();
  });

  it('prints the vault path and an honest empty attachments line', () => {
    render(<DSRPage {...props([report()])} />);
    fireEvent.click(screen.getByLabelText('Print DSR-2082/83-001'));
    const block = screen.getByTestId('dsr-sheet-attachments');
    expect(block.textContent).toContain('No files attached.');
    expect(block.textContent).toContain('Daily Site Reports');
  });

  it('still saves when a linked file is no longer in the vault', async () => {
    const p = props([
      report({
        date: '2026-01-10',
        attachments: [
          { id: 'doc-gone', name: 'gone.pdf', ext: 'pdf', sizeBytes: 1, addedAt: '2026-01-10T08:00:00.000Z' },
        ],
      }),
    ]);
    render(<DSRPage {...p} />);
    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-01' } });
    fireEvent.click(screen.getByLabelText('Edit DSR-2082/83-001'));
    fireEvent.change(screen.getByLabelText('Report date'), { target: { value: '2026-01-11' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dsr-save-draft'));
    });
    expect(p.setDsrData).toHaveBeenCalledTimes(1);
    // The file stays linked, the report is saved, and the supervisor is told.
    const messages = notifyMock.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => /no longer in the Vault/.test(message))).toBe(true);
  });

  it('ignores a second save while the first is still moving files', async () => {
    const p = props([
      report({
        date: '2026-01-10',
        attachments: [
          { id: 'doc-gone', name: 'gone.pdf', ext: 'pdf', sizeBytes: 1, addedAt: '2026-01-10T08:00:00.000Z' },
        ],
      }),
    ]);
    render(<DSRPage {...p} />);
    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-01' } });
    fireEvent.click(screen.getByLabelText('Edit DSR-2082/83-001'));
    fireEvent.change(screen.getByLabelText('Report date'), { target: { value: '2026-01-11' } });

    const button = screen.getByTestId('dsr-save-draft');
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(p.setDsrData).toHaveBeenCalledTimes(1);
  });

  it('leaves the linked files in the vault when the report is deleted', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [new File(['abc'], 'slab.pdf', { type: 'application/pdf' })],
      report: report(),
      ctx: { userId: 'usr-test', projectId: 'PRJ-001' },
      storage: memoryVault,
    });
    const p = props([report({ attachments: uploaded.added })]);
    render(<DSRPage {...p} />);
    fireEvent.click(screen.getByLabelText('Delete DSR-2082/83-001'));

    await waitFor(() => expect(p.setDsrData).toHaveBeenCalled());
    expect((p.setDsrData.mock.calls[0][0] as DsrReport[])).toHaveLength(0);
    expect(documentById(uploaded.added[0].id, 'PRJ-001')).not.toBeNull();
  });

  it('moves a linked file to the new day folder when the report date changes', async () => {
    const reportDate = '2026-01-10';
    const uploaded = await uploadDsrAttachments({
      files: [new File(['abc'], 'slab.pdf', { type: 'application/pdf' })],
      report: report({ date: reportDate, attachments: [] }),
      ctx: { userId: 'usr-test', projectId: 'PRJ-001' },
      storage: memoryVault,
    });
    const docId = uploaded.added[0].id;
    const p = props([report({ date: reportDate, attachments: uploaded.added })]);
    render(<DSRPage {...p} />);

    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-01' } });
    fireEvent.click(screen.getByLabelText('Edit DSR-2082/83-001'));
    fireEvent.change(screen.getByLabelText('Report date'), { target: { value: '2026-01-11' } });
    // The save awaits the folder move, so let React see those state updates.
    await act(async () => {
      fireEvent.click(screen.getByTestId('dsr-save-draft'));
    });

    const target = await dsrFolderChain('2026-01-11', 'PRJ-001');
    await waitFor(() => expect(documentById(docId, 'PRJ-001')?.folderId).toBe(target.dateId));
    // Retarget ran exactly once, for the new date — not on every save.
    expect(retargetCalls).toEqual(['2026-01-11']);
  });
});
