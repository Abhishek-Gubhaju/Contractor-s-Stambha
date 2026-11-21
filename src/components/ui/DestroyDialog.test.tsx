// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DialogHost, destroyDialog } from './DialogHost';
import { seedSignedInUser, TEST_PASSCODE, TEST_PASSWORD } from '../../testUtils/seedAuth';

let answer: boolean | null = null;

function ask() {
  answer = null;
  void destroyDialog({ title: 'Delete BOQ item', message: 'Delete R-101?', confirmLabel: 'Delete item' }).then((value) => {
    answer = value;
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('destructive-action guard', () => {
  it('refuses a wrong passcode and deletes only after the right one', async () => {
    await seedSignedInUser();
    render(<DialogHost />);
    ask();

    const input = await screen.findByTestId('destroy-secret');
    expect(screen.getByText(/Delete R-101/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));
    await screen.findByTestId('destroy-error');
    expect(answer).toBeNull();
    expect(screen.queryByTestId('destroy-dialog')).toBeTruthy();

    fireEvent.change(screen.getByTestId('destroy-secret'), { target: { value: TEST_PASSCODE } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));

    await waitFor(() => expect(answer).toBe(true));
    expect(screen.queryByTestId('destroy-dialog')).toBeNull();
  });

  it('accepts the account password as well', async () => {
    await seedSignedInUser();
    render(<DialogHost />);
    ask();

    fireEvent.change(await screen.findByTestId('destroy-secret'), { target: { value: TEST_PASSWORD } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));

    await waitFor(() => expect(answer).toBe(true));
  });

  it('cancels without deleting', async () => {
    await seedSignedInUser();
    render(<DialogHost />);
    ask();

    fireEvent.click(await screen.findByTestId('destroy-cancel'));
    await waitFor(() => expect(answer).toBe(false));
  });

  it('Escape closes it and answers false', async () => {
    await seedSignedInUser();
    render(<DialogHost />);
    ask();

    await screen.findByTestId('destroy-dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(answer).toBe(false));
    expect(screen.queryByTestId('destroy-dialog')).toBeNull();
  });

  it('asks a password-only account for its password', async () => {
    await seedSignedInUser({ passcode: null });
    render(<DialogHost />);
    ask();

    await screen.findByTestId('destroy-secret');
    expect(screen.getByText(/Enter your account password/i)).toBeTruthy();

    fireEvent.change(screen.getByTestId('destroy-secret'), { target: { value: 'not-the-password' } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));
    await screen.findByTestId('destroy-error');
    expect(answer).toBeNull();

    fireEvent.change(screen.getByTestId('destroy-secret'), { target: { value: TEST_PASSWORD } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));
    await waitFor(() => expect(answer).toBe(true));
  });

  it('refuses to resolve true when nobody is signed in', async () => {
    render(<DialogHost />);
    ask();

    fireEvent.change(await screen.findByTestId('destroy-secret'), { target: { value: TEST_PASSCODE } });
    fireEvent.click(screen.getByTestId('destroy-confirm'));

    const error = await screen.findByTestId('destroy-error');
    expect(error.textContent).toMatch(/sign in again/i);
    expect(answer).toBeNull();
  });
});
