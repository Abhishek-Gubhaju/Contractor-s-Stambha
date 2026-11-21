// @vitest-environment jsdom
// Native confirm/alert do not exist in the desktop WebView, so these dialogs are
// the only way a delete is ever approved.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DialogHost, choiceDialog, confirmDialog, notify } from './DialogHost';

describe('confirmDialog', () => {
  it('resolves true only when the action is confirmed', async () => {
    render(<DialogHost />);
    let answer: Promise<boolean>;
    act(() => {
      answer = confirmDialog({ title: 'Remove project', message: 'Remove PRJ-777?', confirmLabel: 'Remove' });
    });

    expect(await screen.findByTestId('confirm-dialog')).toBeTruthy();
    expect(screen.getByText('Remove PRJ-777?')).toBeTruthy();

    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await expect(answer!).resolves.toBe(true);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('resolves false on cancel, so nothing is deleted', async () => {
    render(<DialogHost />);
    let answer: Promise<boolean>;
    act(() => {
      answer = confirmDialog('Delete this milestone?');
    });
    fireEvent.click(await screen.findByTestId('dialog-cancel'));
    await expect(answer!).resolves.toBe(false);
  });

  it('replaces alert() with a visible toast', async () => {
    render(<DialogHost />);
    act(() => notify('Please select a date', 'error'));
    expect(await screen.findByTestId('toast')).toBeTruthy();
    expect(screen.getByText('Please select a date')).toBeTruthy();
  });
});

describe('choiceDialog', () => {
  it('resolves the option the person picked', async () => {
    render(<DialogHost />);
    let answer: Promise<string | null>;
    act(() => {
      answer = choiceDialog({
        title: 'Back up before signing out?',
        message: 'Keep a dated copy first.',
        options: [
          { value: 'backup', label: 'Back up, then sign out' },
          { value: 'without-backup', label: 'Sign out without a backup', tone: 'neutral' },
        ],
      });
    });

    expect(await screen.findByTestId('choice-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('choice-without-backup'));
    await expect(answer!).resolves.toBe('without-backup');
    expect(screen.queryByTestId('choice-dialog')).toBeNull();
  });

  it('resolves null when cancelled, so the action does not happen', async () => {
    render(<DialogHost />);
    let answer: Promise<string | null>;
    act(() => {
      answer = choiceDialog({ message: 'Leave?', options: [{ value: 'yes', label: 'Leave' }] });
    });
    fireEvent.click(await screen.findByTestId('choice-cancel'));
    await expect(answer!).resolves.toBeNull();
  });
});
