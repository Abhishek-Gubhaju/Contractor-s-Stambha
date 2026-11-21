// @vitest-environment jsdom
// The queue's edge behaviour (cancel one file, retry one file, abort on unmount)
// needs a controllable upload, so this file replaces only that function.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { uploadMock, confirmMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  confirmMock: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../../components/ui/DialogHost', () => ({
  confirmDialog: (...args: unknown[]) => confirmMock(...args),
  destroyDialog: vi.fn(async () => true),
  notify: vi.fn(),
  DialogHost: () => null,
}));

vi.mock('../../services/auth/authService', () => ({
  activeUser: () => ({ id: 'usr-test', username: 'tester', displayName: 'Tester' }),
}));

vi.mock('../../services/dsrAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/dsrAttachments')>();
  return { ...actual, uploadDsrAttachments: uploadMock };
});

import { DsrAttachments } from './DsrAttachments';
import { blankReport, type DsrReport } from '../../services/dsrService';
import { memoryVault, resetMemoryVault } from '../../services/vault/memoryVault';
import { setActiveProject } from '../../services/projectScope';

function report(): DsrReport {
  return { ...blankReport('PRJ-001', '2026-01-10'), reportNo: 'DSR-2082/83-001' };
}

function photo(): File {
  return new File(['abc'], 'photo.jpg', { type: 'image/jpeg' });
}

function renderSection(onAttach = vi.fn()) {
  const utils = render(
    <DsrAttachments
      report={report()}
      locked={false}
      storage={memoryVault}
      onAttach={onAttach}
      onDetach={vi.fn()}
      onOpenInVault={vi.fn()}
    />
  );
  return { ...utils, onAttach };
}

function pickAFile() {
  fireEvent.change(screen.getByTestId('dsr-attach-input'), {
    target: { files: [photo()] },
  });
}

beforeEach(() => {
  localStorage.clear();
  resetMemoryVault();
  setActiveProject('PRJ-001');
  uploadMock.mockReset();
  confirmMock.mockClear();
});

describe('attachment queue', () => {
  it('cancels a single upload without touching the others', async () => {
    uploadMock.mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          input.signal?.addEventListener('abort', () =>
            resolve({ added: [], failed: [{ name: 'photo.jpg', message: 'Cancelled.' }] })
          );
        })
    );
    renderSection();
    pickAFile();

    const cancel = await screen.findByLabelText('Cancel photo.jpg');
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.getByTestId('dsr-attach-queue-cancelled')).toBeTruthy());
    expect(screen.getByLabelText('Retry photo.jpg')).toBeTruthy();
  });

  it('retries one failed file and links it once it succeeds', async () => {
    const added = {
      id: 'doc-retry',
      name: 'photo.jpg',
      ext: 'jpg',
      sizeBytes: 3,
      addedAt: '2026-01-10T08:00:00.000Z',
    };
    uploadMock
      .mockResolvedValueOnce({ added: [], failed: [{ name: 'photo.jpg', message: 'network down' }] })
      .mockResolvedValueOnce({ added: [added], failed: [] });

    const { onAttach } = renderSection();
    pickAFile();

    expect(await screen.findByTestId('dsr-attach-queue-error')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Retry photo.jpg'));

    await waitFor(() => expect(onAttach).toHaveBeenCalledWith([added]));
    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  it('aborts an upload that is still running when the editor closes', async () => {
    let captured: AbortSignal | undefined;
    uploadMock.mockImplementation((input: { signal?: AbortSignal }) => {
      captured = input.signal;
      return new Promise(() => undefined);
    });

    const { unmount } = renderSection();
    pickAFile();
    await waitFor(() => expect(captured).toBeTruthy());

    unmount();
    expect(captured?.aborted).toBe(true);
  });
});
