// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));

vi.mock('../components/ui/DialogHost', () => ({
  confirmDialog: vi.fn(async () => true),
  destroyDialog: vi.fn(async () => true),
  notify: (...args: unknown[]) => notifyMock(...args),
  DialogHost: () => null,
}));

vi.mock('../services/auth/authService', () => ({
  activeUser: () => ({ id: 'usr-test', username: 'tester', displayName: 'Tester' }),
}));

import FileVaultPage from './FileVault';
import { memoryVault, resetMemoryVault } from '../services/vault/memoryVault';
import { setVaultStorage } from '../services/vault/vaultStorage';
import { setActiveProject } from '../services/projectScope';
import {
  createFolder,
  deleteFolder,
  listDocuments,
  listFolders,
  uploadDocument,
} from '../services/vault/vaultService';
import { dsrFolderChain, focusInVault } from '../services/dsrAttachments';

const ctx = { userId: 'usr-test', projectId: 'PRJ-001' };

function file(name: string, contents: string, type = 'application/pdf'): File {
  return new File([contents], name, { type });
}

async function pick(...files: File[]) {
  const input = screen.getByTestId('vault-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  localStorage.clear();
  resetMemoryVault();
  setVaultStorage(memoryVault);
  setActiveProject('PRJ-001');
  notifyMock.mockClear();
});

afterEach(() => {
  cleanup();
  setVaultStorage(null);
});

it('starts empty and adds a dropped or picked file to the vault', async () => {
  render(<FileVaultPage />);
  expect(await screen.findByTestId('vault-empty')).toBeTruthy();

  await pick(file('site-plan.pdf', 'drawing bytes'));
  expect(await screen.findByText('site-plan.pdf')).toBeTruthy();
  await waitFor(() => expect(listDocuments('PRJ-001')).toHaveLength(1));
  expect(listDocuments('PRJ-001')[0].kind).toBe('pdf');
});

it('searches and filters by file type', async () => {
  await uploadDocument({ file: file('site-plan.pdf', 'a'), ctx, storage: memoryVault });
  await uploadDocument({
    file: file('quote.docx', 'b', 'application/msword'),
    ctx,
    storage: memoryVault,
  });
  render(<FileVaultPage />);
  await screen.findByText('site-plan.pdf');

  fireEvent.change(screen.getByTestId('vault-search'), { target: { value: 'quote' } });
  await waitFor(() => expect(screen.queryByText('site-plan.pdf')).toBeNull());
  expect(screen.getByText('quote.docx')).toBeTruthy();

  fireEvent.change(screen.getByTestId('vault-search'), { target: { value: '' } });
  await waitFor(() => expect(screen.getByText('site-plan.pdf')).toBeTruthy());
  fireEvent.click(screen.getByTestId('vault-kind-drawing'));
  expect(await screen.findByTestId('vault-no-results')).toBeTruthy();
});

it('renames a file from the details pane', async () => {
  const doc = (await uploadDocument({ file: file('draft.pdf', 'a'), ctx, storage: memoryVault }))
    .document;
  render(<FileVaultPage />);
  fireEvent.click(await screen.findByTestId(`vault-row-${doc.id}`));
  fireEvent.click(await screen.findByTestId('vault-rename'));

  const input = screen.getByTestId('vault-name-input');
  fireEvent.change(input, { target: { value: 'issued-plan.pdf' } });
  fireEvent.click(screen.getByTestId('vault-name-save'));

  await waitFor(() =>
    expect(listDocuments('PRJ-001').find((row) => row.id === doc.id)?.name).toBe('issued-plan.pdf')
  );
});

it('moves a file to the trash, restores it, and can undo a delete', async () => {
  const doc = (await uploadDocument({ file: file('bill.pdf', 'a'), ctx, storage: memoryVault }))
    .document;
  render(<FileVaultPage />);
  fireEvent.click(await screen.findByTestId(`vault-row-${doc.id}`));
  fireEvent.click(await screen.findByTestId('vault-delete'));

  await waitFor(() => expect(screen.queryByTestId(`vault-row-${doc.id}`)).toBeNull());
  expect(listDocuments('PRJ-001')[0].deletedAt).toBeTruthy();

  fireEvent.click(screen.getByTestId('vault-trash-toggle'));
  const trashedRow = await screen.findByTestId(`vault-row-${doc.id}`);
  fireEvent.click(trashedRow);
  fireEvent.click(await screen.findByTestId('vault-restore'));
  await waitFor(() => expect(listDocuments('PRJ-001')[0].deletedAt).toBeUndefined());

  fireEvent.click(screen.getByTestId('vault-trash-toggle'));
  await screen.findByTestId(`vault-row-${doc.id}`);
  fireEvent.click(screen.getByTestId(`vault-row-${doc.id}`));
  fireEvent.click(await screen.findByTestId('vault-delete'));
  await waitFor(() => expect(listDocuments('PRJ-001')[0].deletedAt).toBeTruthy());
  fireEvent.click(await screen.findByTestId('vault-undo'));
  await waitFor(() => expect(listDocuments('PRJ-001')[0].deletedAt).toBeUndefined());
});

it('reports a missing file honestly instead of showing a broken preview', async () => {
  const doc = (await uploadDocument({ file: file('photo.png', 'a', 'image/png'), ctx, storage: memoryVault }))
    .document;
  await memoryVault.remove(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' });
  render(<FileVaultPage />);
  fireEvent.click(await screen.findByTestId(`vault-row-${doc.id}`));
  expect(await screen.findByText('Missing on this computer')).toBeTruthy();
});

it('reloads the vault when the job changes', async () => {
  await uploadDocument({ file: file('job-one.pdf', 'a'), ctx, storage: memoryVault });
  render(<FileVaultPage />);
  await screen.findByText('job-one.pdf');

  act(() => setActiveProject('PRJ-002'));
  expect(await screen.findByTestId('vault-empty')).toBeTruthy();
  expect(screen.queryByText('job-one.pdf')).toBeNull();

  act(() => setActiveProject('PRJ-001'));
  expect(await screen.findByText('job-one.pdf')).toBeTruthy();
});

it('deleting a folder moves its files up rather than deleting them', async () => {
  const folder = createFolder('Drawings', null, 'PRJ-001');
  const doc = (
    await uploadDocument({
      file: file('layout.dwg', 'a', 'application/acad'),
      ctx,
      folderId: folder.id,
      storage: memoryVault,
    })
  ).document;

  render(<FileVaultPage />);
  fireEvent.click(await screen.findByTestId(`vault-folder-${folder.id}`));
  fireEvent.click(await screen.findByTestId(`vault-folder-delete-${folder.id}`));

  await waitFor(() => expect(listFolders('PRJ-001')).toHaveLength(0));
  expect(listDocuments('PRJ-001').find((row) => row.id === doc.id)?.folderId).toBeNull();
  expect(await screen.findByTestId(`vault-row-${doc.id}`)).toBeTruthy();
});

it('files a dropped file into the folder it was dropped on', async () => {
  const folder = createFolder('Drawings', null, 'PRJ-001');
  render(<FileVaultPage />);
  const row = (await screen.findByTestId(`vault-folder-${folder.id}`)).parentElement!;

  fireEvent.drop(row, {
    dataTransfer: { files: [file('layout.dwg', 'a', 'application/acad')] },
  });

  await waitFor(() => expect(listDocuments('PRJ-001')).toHaveLength(1));
  expect(listDocuments('PRJ-001')[0]).toMatchObject({
    name: 'layout.dwg',
    folderId: folder.id,
  });
});

it('marks the DSR folder as managed and refuses to delete it', async () => {
  const managed = createFolder('Daily Site Reports', null, 'PRJ-001', 'dsr');
  render(<FileVaultPage />);

  expect(await screen.findByTestId(`vault-folder-managed-${managed.id}`)).toBeTruthy();
  expect(screen.queryByTestId(`vault-folder-delete-${managed.id}`)).toBeNull();
  expect(() => deleteFolder(managed.id, 'PRJ-001')).toThrow(/managed by Daily Site Reports/i);
});

it('expands the DSR month and day folders that hold the focused file', async () => {
  const chain = await dsrFolderChain('2026-01-10', 'PRJ-001');
  const doc = (
    await uploadDocument({
      file: file('cube.pdf', 'a'),
      ctx,
      folderId: chain.dateId,
      storage: memoryVault,
    })
  ).document;
  focusInVault({ projectId: 'PRJ-001', docId: doc.id });
  render(<FileVaultPage />);

  expect(await screen.findByTestId(`vault-folder-${chain.monthId}`)).toBeTruthy();
  expect(screen.getByTestId(`vault-folder-${chain.dateId}`)).toBeTruthy();
  expect(screen.getByTestId('vault-details')).toBeTruthy();
});

it('says so when asked to open a file that is no longer indexed', async () => {
  focusInVault({ projectId: 'PRJ-001', docId: 'doc-missing' });
  render(<FileVaultPage />);

  await waitFor(() => expect(notifyMock).toHaveBeenCalled());
  expect(String(notifyMock.mock.calls[0][0])).toMatch(/no longer in the File Vault/);
  expect(screen.queryByTestId('vault-details')).toBeNull();
});

it('opens on the file a DSR asked it to show, and consumes the instruction', async () => {
  const doc = (await uploadDocument({ file: file('slab.pdf', 'a'), ctx, storage: memoryVault }))
    .document;
  focusInVault({ projectId: 'PRJ-001', docId: doc.id });
  render(<FileVaultPage />);

  expect(await screen.findByTestId('vault-details')).toBeTruthy();
  expect(screen.getAllByText('slab.pdf').length).toBeGreaterThan(0);
  expect(localStorage.getItem('contractoros_vault_focus')).toBeNull();
});
