// One read of every source a rule may need. Sources are read through the
// project scope, so a notification can never describe another job's data.
import { getActiveProject, readScoped } from '../projectScope';
import { migrateReports } from '../dsrService';
import { ACTIVITIES_KEY, type Activity } from '../dsrSyncService';
import {
  STOCK_ITEMS_KEY,
  STOCK_MOVEMENTS_KEY,
  type ItemStock,
  type StockItem,
  type StockMovement,
} from '../stockService';
import { RUNS_KEY, type PayrollRun } from '../labourService';
import { staffOverLeaveLimit } from '../staffAttendanceService';
import { parties, type PartyRow } from '../booksService';
import { getTodayBS } from '../../utils/nepaliDate';
import { getCurrentMonthInTimezone, todayISOInKathmandu } from '../../utils';
import { lastBackup } from '../backup/backupService';
import { readAutoBackup } from '../backup/autoBackup';
import { isDesktopApp } from '../backup/desktop';
import type { AppBOQSection, AppMilestone } from '../../types';
import type { NotificationContext } from './types';

const DSR_KEY = 'contractoros_dsr';
const BOQ_KEY = 'contractoros_boq';
const MILESTONES_KEY = 'contractoros_milestones';
const TIMEZONE_KEY = 'contractoros_settings_timezone';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** One malformed legacy row must not stop every other reminder. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The app's chosen timezone is a machine preference, stored as JSON. */
function appTimezone(): string {
  try {
    const raw = localStorage.getItem(TIMEZONE_KEY);
    if (!raw) return 'Asia/Kathmandu';
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' && parsed.trim() ? parsed : 'Asia/Kathmandu';
  } catch {
    return 'Asia/Kathmandu';
  }
}

/** Stock on hand for the requested job, without the active-project shortcut. */
function stockFor(projectId: string): ItemStock[] {
  const items = readScoped<StockItem[]>(STOCK_ITEMS_KEY, [], projectId);
  const movements = readScoped<StockMovement[]>(STOCK_MOVEMENTS_KEY, [], projectId);
  const usableItems = (Array.isArray(items) ? items : []).filter(
    (item) => item && typeof item.id === 'string'
  );
  const byItem = new Map<string, { qty: number; value: number }>();
  for (const move of Array.isArray(movements) ? movements : []) {
    if (!move || typeof move.item_id !== 'string') continue;
    const row = byItem.get(move.item_id) || { qty: 0, value: 0 };
    row.qty = round2(row.qty + (Number(move.qty) || 0));
    row.value = round2(row.value + (Number(move.qty) || 0) * (Number(move.rate) || 0));
    byItem.set(move.item_id, row);
  }
  return usableItems.map((item) => {
    const row = byItem.get(item.id) || { qty: 0, value: 0 };
    const reorderLevel = Number(item.reorderLevel) || 0;
    return {
      item,
      qty: row.qty,
      value: row.value,
      avg: row.qty > 0 ? round2(row.value / row.qty) : 0,
      shortfall: reorderLevel > 0 && row.qty < reorderLevel ? round2(reorderLevel - row.qty) : 0,
    };
  });
}

export function buildNotificationContext(
  now = Date.now(),
  projectId = getActiveProject()
): NotificationContext {
  const timezone = appTimezone();
  const active = projectId === getActiveProject();
  const dsr = safe(() => migrateReports(readScoped<unknown>(DSR_KEY, [], projectId), projectId), []);
  const boq = safe(() => readScoped<AppBOQSection[]>(BOQ_KEY, [], projectId), []);
  const payrollRuns = safe(() => readScoped<PayrollRun[]>(RUNS_KEY, [], projectId), []);
  const activities = safe(() => readScoped<Activity[]>(ACTIVITIES_KEY, [], projectId), []);
  const milestones = safe(() => readScoped<AppMilestone[]>(MILESTONES_KEY, [], projectId), []);

  let partyCache: PartyRow[] | null = null;
  const loadParties = (): PartyRow[] => {
    if (partyCache) return partyCache;
    try {
      const today = getTodayBS();
      partyCache = parties({ year: today.year, month: today.month });
    } catch {
      partyCache = [];
    }
    return partyCache;
  };

  return {
    now,
    todayAD: todayISOInKathmandu(),
    timezone,
    projectId,
    dsr: Array.isArray(dsr) ? dsr.filter(Boolean) : [],
    boq: Array.isArray(boq) ? boq.filter(Boolean) : [],
    stock: safe(() => stockFor(projectId), []),
    payrollRuns: Array.isArray(payrollRuns) ? payrollRuns.filter(Boolean) : [],
    activities: Array.isArray(activities)
      ? activities.filter((activity) => activity && typeof activity.id === 'string')
      : [],
    milestones: Array.isArray(milestones)
      ? milestones.filter((milestone) => milestone && typeof milestone.id === 'string')
      : [],
    // Staff attendance is scoped through the active job; a background read of
    // a different job is never needed (the watcher follows the active one).
    staffLeave: active
      ? safe(
          () =>
            staffOverLeaveLimit(getCurrentMonthInTimezone(timezone).slice(0, 7)).filter(
              (row) => row && typeof row.staff_id === 'string'
            ),
          []
        )
      : [],
    loadParties,
    backup: {
      last: safe(() => lastBackup(), null),
      auto: safe(() => readAutoBackup(), null),
      desktop: safe(() => isDesktopApp(), false),
    },
  };
}
