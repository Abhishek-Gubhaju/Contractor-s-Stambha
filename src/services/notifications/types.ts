// Notifications — the inbox is a derived cache; the business stores are truth.
//
// A rule is a pure function of (context, preferences): it reads nothing from
// storage itself, never reads the clock, and returns candidates. The sync
// engine merges candidates into the per-job inbox using a stable dedupe key,
// so a refresh cannot duplicate a reminder, resurrect a dismissed one, or
// overwrite the read state a person chose.
import type { AppBOQSection, AppMilestone } from '../../types';
import type { DsrReport } from '../dsrService';
import type { ItemStock, StockItem, StockMovement } from '../stockService';
import type { PayrollRun } from '../labourService';
import type { Activity } from '../dsrSyncService';
import type { StaffAttendanceSummary } from '../staffAttendanceService';
import type { PartyRow } from '../booksService';
import type { BackupResult } from '../backup/backupService';
import type { AutoBackupRecord } from '../backup/autoBackup';

export const NOTIFICATION_KINDS = [
  'dsr',
  'boq',
  'bill',
  'invoice',
  'stock',
  'payroll',
  'staff',
  'schedule',
  'backup',
  'vault',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export const NOTIFICATION_RULE_IDS = [
  'dsr-draft',
  'dsr-approval',
  'dsr-missing',
  'boq-overrun',
  'boq-nearly',
  'bill-due',
  'invoice-due',
  'stock-low',
  'payroll-unpaid',
  'staff-leave',
  'schedule-late',
  'backup-stale',
] as const;

export type NotificationRuleId = (typeof NOTIFICATION_RULE_IDS)[number];

export type NotificationRuleMap = Record<NotificationRuleId, boolean>;

/** Where a notification takes the person when opened. */
export interface NotificationAction {
  page: string;
  entityId?: string;
}

export interface AppNotification {
  /** Stable identity: the dedupe key. */
  id: string;
  dedupeKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  projectId: string;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  action: NotificationAction;
  meta: Record<string, string>;
}

/** What a rule returns; the engine supplies id/createdAt/read state. */
export interface NotificationCandidate {
  dedupeKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  action: NotificationAction;
  meta?: Record<string, string>;
}

export interface NotificationPrefs {
  /** Master switch. Off stops generation; existing items stay stored. */
  enabled: boolean;
  rules: NotificationRuleMap;
  /** A bill/invoice due within this many days is "due soon". */
  dueSoonDays: number;
  /** A DSR draft older than this many days is worth reminding about. */
  dsrStaleDays: number;
  /** A backup older than this many days is stale. */
  backupStaleDays: number;
  /** Also show a toast when a new critical notification appears. */
  toasts: boolean;
}

export interface NotificationContext {
  now: number;
  todayAD: string;
  timezone: string;
  projectId: string;
  dsr: DsrReport[];
  boq: AppBOQSection[];
  stock: ItemStock[];
  payrollRuns: PayrollRun[];
  activities: Activity[];
  milestones: AppMilestone[];
  staffLeave: StaffAttendanceSummary[];
  /** Lazy: the ledger scan only runs when a money rule asks for it. */
  loadParties: () => PartyRow[];
  backup: {
    last: BackupResult | null;
    auto: AutoBackupRecord | null;
    desktop: boolean;
  };
}

export interface NotificationRule {
  id: NotificationRuleId;
  kind: NotificationKind;
  /** Human label for the preferences card. */
  label: string;
  description: string;
  defaultEnabled: boolean;
  evaluate: (ctx: NotificationContext, prefs: NotificationPrefs) => NotificationCandidate[];
}

export type { StockItem, StockMovement };
