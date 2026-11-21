// @vitest-environment jsdom
// Staff records: a blank code is generated, a photo and documents can be
// attached, and both are viewable from the staff details.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import StaffInfoPage from './StaffInfo';

afterEach(cleanup);

function setFiles(input: HTMLElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function openAdd() {
  render(<StaffInfoPage staffData={[]} setStaffData={() => {}} deletedStaff={[]} setDeletedStaff={() => {}} />);
  fireEvent.click(screen.getByTestId('add-staff'));
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Asha' } });
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Rai' } });
}

describe('staff codes', () => {
  it('generates STF-001 when the code is left blank', () => {
    let saved: any[] = [];
    render(<StaffInfoPage staffData={[]} setStaffData={(v: any) => { saved = v; }} deletedStaff={[]} setDeletedStaff={() => {}} />);
    fireEvent.click(screen.getByTestId('add-staff'));
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Asha' } });
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Rai' } });
    fireEvent.click(screen.getByTestId('staff-save'));

    expect(saved).toHaveLength(1);
    expect(saved[0].code).toBe('STF-001');
    expect(saved[0].firstName).toBe('Asha');
  });

  it('continues the series after the highest code on file', () => {
    let saved: any[] = [];
    const existing = [{ id: 's1', code: 'STF-004', firstName: 'A', lastName: 'B', status: 'active' }];
    render(<StaffInfoPage staffData={existing} setStaffData={(v: any) => { saved = v; }} deletedStaff={[{ id: 'd1', code: 'STF-009' }]} setDeletedStaff={() => {}} />);
    fireEvent.click(screen.getByTestId('add-staff'));
    expect(screen.getByTestId('staff-code').getAttribute('placeholder')).toBe('STF-010');
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Ram' } });
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Thapa' } });
    fireEvent.click(screen.getByTestId('staff-save'));

    expect(saved.map((s: any) => s.code)).toEqual(['STF-004', 'STF-010']);
  });
});

describe('staff photo and documents', () => {
  it('keeps the picked photo and attached documents on the record', async () => {
    let saved: any[] = [];
    render(<StaffInfoPage staffData={[]} setStaffData={(v: any) => { saved = v; }} deletedStaff={[]} setDeletedStaff={() => {}} />);
    fireEvent.click(screen.getByTestId('add-staff'));
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Asha' } });
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Rai' } });

    const photo = new File([new Uint8Array([137, 80, 78, 71])], 'asha.png', { type: 'image/png' });
    setFiles(screen.getByTestId('staff-photo-input'), [photo]);
    // The read is async: wait for the preview before attaching the scan.
    expect(await screen.findByAltText('Asha Rai')).toBeTruthy();
    const doc = new File(['citizenship'], 'citizenship.txt', { type: 'text/plain' });
    setFiles(screen.getByTestId('staff-doc-input'), [doc]);

    expect(await screen.findByText('citizenship.txt')).toBeTruthy();
    fireEvent.click(screen.getByTestId('staff-save'));

    expect(saved[0].photo.startsWith('data:image/png;base64,')).toBe(true);
    expect(saved[0].documents).toHaveLength(1);
    expect(saved[0].documents[0]).toMatchObject({
      fileName: 'citizenship.txt',
      mimeType: 'text/plain',
      category: 'Citizenship Copy',
    });
    expect(saved[0].documents[0].dataUrl.startsWith('data:text/plain;base64,')).toBe(true);
  });

  it('shows the photo and lets the documents be viewed from the profile', async () => {
    const records = [
      {
        id: 's1',
        code: 'STF-001',
        firstName: 'Asha',
        lastName: 'Rai',
        status: 'active',
        photo: 'data:image/png;base64,AAAA',
        documents: [
          { id: 'd1', category: 'Citizenship Copy', fileName: 'citizenship.txt', mimeType: 'text/plain', sizeBytes: 11, uploadedAt: '2026-11-01T00:00:00.000Z', dataUrl: 'data:text/plain;base64,aGVsbG8=' },
        ],
      },
    ];
    render(<StaffInfoPage staffData={records} setStaffData={() => {}} deletedStaff={[]} setDeletedStaff={() => {}} />);

    expect(screen.getByAltText('Asha Rai').getAttribute('src')).toBe('data:image/png;base64,AAAA');

    fireEvent.click(screen.getByTitle('View'));
    const panel = screen.getByTestId('staff-documents');
    expect(panel.textContent).toContain('citizenship.txt');
    expect(panel.textContent).toContain('Citizenship Copy');

    fireEvent.click(screen.getByText('View'));
    await waitFor(() => expect(screen.getByTestId('doc-preview')).toBeTruthy());
    expect(screen.getByTestId('doc-preview').textContent).toContain('citizenship.txt');
  });
});
