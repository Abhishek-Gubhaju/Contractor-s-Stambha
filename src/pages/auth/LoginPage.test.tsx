// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoginPage from './LoginPage';
import { SIGNED_OUT_KEY, LAST_USER_KEY } from '../../services/auth/authService';

const filled = () =>
  screen.getAllByLabelText(/Digit (entered|empty)/).filter((el) => el.getAttribute('aria-label') === 'Digit entered').length;

const remembered = { id: 'usr-1', username: 'alex', name: 'Alex G.', hasPasscode: true };

describe('Locked screen keypad', () => {
  beforeEach(() => localStorage.clear());

  it('accepts passcode digits from the keyboard and deletes with Backspace', () => {
    render(<LoginPage mode="locked" signedInName="Alex" onAuthenticated={vi.fn()} />);
    expect(screen.getByTestId('lock-screen')).toBeTruthy();
    expect(filled()).toBe(0);

    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '6' });
    expect(filled()).toBe(3);

    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(filled()).toBe(2);

    // Non-digits are ignored.
    fireEvent.keyDown(window, { key: 'a' });
    expect(filled()).toBe(2);
  });

  it('still fills from the on-screen keypad', () => {
    render(<LoginPage mode="locked" onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(filled()).toBe(2);
  });
});

describe('Sign out and account choice', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks for the password — not the passcode — right after an explicit sign-out', () => {
    localStorage.setItem(SIGNED_OUT_KEY, new Date().toISOString());
    render(<LoginPage mode="login" remembered={remembered} onAuthenticated={vi.fn()} />);

    expect(screen.getByTestId('signed-out-note')).toBeTruthy();
    expect(screen.getByTestId('login-form')).toBeTruthy();
    expect(screen.queryByLabelText('Passcode')).toBeNull();
    // The username is prefilled so signing back in is one password away.
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('alex');
  });

  it('still offers the passcode as a deliberate choice after sign-out', () => {
    localStorage.setItem(SIGNED_OUT_KEY, new Date().toISOString());
    render(<LoginPage mode="login" remembered={remembered} onAuthenticated={vi.fn()} />);

    fireEvent.click(screen.getByTestId('use-passcode'));
    expect(screen.getByTestId('lock-screen')).toBeTruthy();
    expect(screen.queryByTestId('login-form')).toBeNull();
  });

  it('offers creation of a separate account from the sign-in screen', () => {
    render(<LoginPage mode="login" onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('create-account-link'));

    expect(screen.getByTestId('create-account-form')).toBeTruthy();
    // Three different security questions are chosen up front.
    expect(screen.getByLabelText('Security question 1')).toBeTruthy();
    expect(screen.getByLabelText('Security question 2')).toBeTruthy();
    expect(screen.getByLabelText('Security question 3')).toBeTruthy();
  });

  it('opens the recovery screen from “Forgot password?”', () => {
    render(<LoginPage mode="login" onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('forgot-password'));

    expect(screen.getByTestId('recovery-view')).toBeTruthy();
    expect(screen.getByLabelText('Account username')).toBeTruthy();
  });

  it('sets up recovery as part of first-run setup', () => {
    render(<LoginPage mode="setup" onAuthenticated={vi.fn()} />);
    expect(screen.getByTestId('setup-form')).toBeTruthy();
    expect(screen.getByLabelText('Security question 1')).toBeTruthy();
    expect(screen.getByText(/recovery key is generated/i)).toBeTruthy();
  });
});
