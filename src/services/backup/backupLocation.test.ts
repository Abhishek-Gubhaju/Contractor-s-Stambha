// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BACKUP_LOCATION_KEY,
  DEFAULT_BACKUP_LOCATION_LABEL,
  backupLocationLabel,
  backupLocationProblem,
  loadBackupLocation,
  saveBackupLocation,
} from './backupLocation';

beforeEach(() => localStorage.clear());

describe('backup location', () => {
  it('defaults to Documents/Stambha', () => {
    expect(loadBackupLocation()).toBeNull();
    expect(backupLocationLabel()).toBe(DEFAULT_BACKUP_LOCATION_LABEL);
  });

  it('remembers a chosen folder and trims it', () => {
    saveBackupLocation('  /Volumes/Backups  ');
    expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBe('/Volumes/Backups');
    expect(loadBackupLocation()).toBe('/Volumes/Backups');
    expect(backupLocationLabel()).toBe('/Volumes/Backups');
  });

  it('clears back to the default', () => {
    saveBackupLocation('/Volumes/Backups');
    saveBackupLocation('');
    expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBeNull();
    expect(loadBackupLocation()).toBeNull();
    expect(backupLocationLabel()).toBe(DEFAULT_BACKUP_LOCATION_LABEL);
  });

  it('accepts absolute paths, home paths and Windows drives', () => {
    expect(backupLocationProblem('/Users/me/Backups')).toBeNull();
    expect(backupLocationProblem('~/Backups')).toBeNull();
    expect(backupLocationProblem('~')).toBeNull();
    expect(backupLocationProblem('\\\\NAS\\Backups')).toBeNull();
    expect(backupLocationProblem('D:\\Backups')).toBeNull();
    expect(backupLocationProblem('')).toBeNull();
  });

  it('rejects relative paths and traversal', () => {
    expect(backupLocationProblem('Backups')).toMatch(/absolute/i);
    expect(backupLocationProblem('./Backups')).toMatch(/absolute/i);
    expect(backupLocationProblem('/Users/me/../Backups')).toMatch(/\.\./);
    expect(backupLocationProblem('/Users/me/\0Backups')).toMatch(/not valid/i);
  });
});
