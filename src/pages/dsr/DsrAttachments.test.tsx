// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { confirmMock, notifyMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async (..._args: unknown[]) => true),
  notifyMock: vi.fn(),
}));

vi.mock('../../components/ui/DialogHost', () => ({
  confirmDialog: (...args: unknown[]) => confirmMock(...args),
  destroyDialog: vi.fn(async () => true),
  notify: (...args: unknown[]) => notifyMock(...args),
  DialogHost: () => null,
}));

vi.mock('../../services/auth/authService', () => ({
  activeUser: () => ({ id: 'usr-test', username: 'tester', displayName: 'Tester' }),
}));

import { DsrAttachments } from './DsrAttachments';
import {
  blankReport,
  MAX_DSR_ATTACHMENTS,
  type DsrAttachment,
  type DsrReport,
} from '../../services/dsrService';
import { memoryVault, resetMemoryVault } from '../../services/vault/memoryVault';
import { documentById, listDocuments, trashDocument } from '../../services/vault/vaultService';
import { uploadDsrAttachments } from '../../services/dsrAttachments';
import { setActiveProject } from '../../services/projectScope';

function report(overrides: Partial<DsrReport> = {}): DsrReport {
  return {
    ...blankReport('PRJ-001', '2026-01-10'),
    reportNo: 'DSR-2082/83-001',
    ...overrides,
  };
}

function attachment(id: string, name = 'slab.jpg'): DsrAttachment {
  return { id, name, ext: 'jpg', sizeBytes: 1200, addedAt: '2026-01-10T08:00:00.000Z' };
}

function renderSection(overrides: Partial<React.ComponentProps<typeof DsrAttachments>> = {}) {
  const onAttach = vi.fn();
  const onDetach = vi.fn();
  const onOpenInVault = vi.fn();
  render(
    <DsrAttachments
      report={report()}
      locked={false}
      storage={memoryVault}
      onAttach={onAttach}
      onDetach={onDetach}
      onOpenInVault={onOpenInVault}
      {...overrides}
    />
  );
  return { onAttach, onDetach, onOpenInVault };
}

beforeEach(() => {
  localStorage.clear();
  resetMemoryVault();
  setActiveProject('PRJ-001');
  confirmMock.mockClear();
  notifyMock.mockClear();
});

describe('DSR attachment section', () => {
  it('starts empty and explains that removing a file only unlinks it', () => {
    renderSection();
    expect(screen.getByTestId('dsr-attachments')).toBeTruthy();
    expect(screen.getByText(/No files yet/)).toBeTruthy();
    expect(screen.getByText(/only unlinks it/)).toBeTruthy();
    expect(screen.getByText(/0 of 50 files linked/)).toBeTruthy();
  });

  it('uploads a picked file into the report day folder and reports the link', async () => {
    const { onAttach } = renderSection();
    const input = screen.getByTestId('dsr-attach-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'slab.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    const added = onAttach.mock.calls[0][0] as DsrAttachment[];
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: 'slab.pdf', ext: 'pdf', sizeBytes: 3 });
    const doc = documentById(added[0].id, 'PRJ-001')!;
    expect(doc.name).toBe('slab.pdf');
    expect(listDocuments('PRJ-001')).toHaveLength(1);
    expect(await screen.findByTestId('dsr-attach-queue-done')).toBeTruthy();
  });

  it('offers a camera input that asks for the rear camera and images only', () => {
    renderSection();
    const photo = screen.getByTestId('dsr-attach-photo-input') as HTMLInputElement;
    expect(photo.getAttribute('accept')).toBe('image/*');
    expect(photo.getAttribute('capture')).toBe('environment');
    expect(photo.multiple).toBe(true);
  });

  it('adds files dropped onto the section', async () => {
    const { onAttach } = renderSection();
    fireEvent.drop(screen.getByTestId('dsr-attach-drop'), {
      dataTransfer: { files: [new File(['abc'], 'dropped.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect((onAttach.mock.calls[0][0] as DsrAttachment[])[0].name).toBe('dropped.pdf');
  });

  it('adds an image pasted from the clipboard', async () => {
    const { onAttach } = renderSection();
    fireEvent.paste(screen.getByTestId('dsr-attachments'), {
      clipboardData: {
        files: [new File(['abc'], 'pasted.png', { type: 'image/png' })],
      },
    });
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect((onAttach.mock.calls[0][0] as DsrAttachment[])[0].name).toBe('pasted.png');
  });

  it('files the upload under the report’s own job, not the open one', async () => {
    setActiveProject('PRJ-001');
    const { onAttach } = renderSection({ report: report({ project_id: 'PRJ-002' }) });
    fireEvent.change(screen.getByTestId('dsr-attach-input'), {
      target: { files: [new File(['abc'], 'other-job.pdf')] },
    });
    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(listDocuments('PRJ-002')).toHaveLength(1);
    expect(listDocuments('PRJ-001')).toHaveLength(0);
  });

  it('shows an error and a retry control when a file cannot be stored', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('dsr-attach-input'), {
      target: { files: [new File([], 'empty.pdf')] },
    });
    expect(await screen.findByTestId('dsr-attach-error')).toBeTruthy();
    expect(await screen.findByTestId('dsr-attach-queue-error')).toBeTruthy();
    expect(screen.getByLabelText('Retry empty.pdf')).toBeTruthy();
  });

  it('renders a linked file with its name and marks a trashed one', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [new File(['abc'], 'photo.jpg', { type: 'image/jpeg' })],
      report: report(),
      ctx: { userId: 'usr-test', projectId: 'PRJ-001' },
      storage: memoryVault,
    });
    trashDocument(uploaded.added[0].id, 'PRJ-001');
    renderSection({ report: report({ attachments: uploaded.added }) });
    expect(screen.getByText('photo.jpg')).toBeTruthy();
    expect(screen.getByText('In Trash')).toBeTruthy();
  });

  it('shows a linked file that is no longer in the vault', () => {
    renderSection({
      report: report({ attachments: [attachment('doc-gone', 'missing.jpg')] }),
    });
    expect(screen.getByText('Not in Vault')).toBeTruthy();
  });

  it('disables adding files once the 50-file cap is reached', () => {
    const attachments = Array.from({ length: MAX_DSR_ATTACHMENTS }, (_, index) => ({
      id: `doc-${index}`,
      name: `photo-${index}.jpg`,
      ext: 'jpg',
      sizeBytes: 10,
      addedAt: '2026-01-10T08:00:00.000Z',
    }));
    renderSection({ report: report({ attachments }) });

    expect((screen.getByTestId('dsr-attach-add') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('dsr-attach-photo') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/50 of 50 files linked/)).toBeTruthy();
  });

  it('is read-only for an approved report', () => {
    renderSection({
      locked: true,
      report: report({ attachments: [attachment('doc-gone', 'locked.jpg')] }),
    });
    expect((screen.getByTestId('dsr-attach-add') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('dsr-attach-photo') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('dsr-attach-remove-doc-gone')).toBeNull();
  });

  it('detaches a file after confirming, and says the file stays in the vault', async () => {
    const { onDetach } = renderSection({
      report: report({ attachments: [attachment('doc-gone', 'kept.jpg')] }),
    });
    fireEvent.click(screen.getByTestId('dsr-attach-remove-doc-gone'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(String((confirmMock.mock.calls[0][0] as { message?: string }).message)).toContain(
      'nothing is deleted'
    );
    expect(onDetach).toHaveBeenCalledWith('doc-gone');
  });

  it('opens the vault for a linked file', () => {
    const { onOpenInVault } = renderSection({
      report: report({ attachments: [attachment('doc-gone', 'open.jpg')] }),
    });
    fireEvent.click(screen.getByTestId('dsr-attach-open-doc-gone'));
    expect(onOpenInVault).toHaveBeenCalledWith('doc-gone');
  });

  it('warns when the browser keeps the bytes, not the desktop', () => {
    renderSection({ storage: { ...memoryVault, mode: 'browser' } });
    expect(screen.getByTestId('dsr-attach-mode').textContent).toContain('browser only');
  });
});
