import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, money, notificationKey, plural } from './helpers';

/** A supplier bill still open and due within the lead time, or overdue. */
export const billDueRule: NotificationRule = {
  id: 'bill-due',
  kind: 'bill',
  label: 'Supplier bills due',
  description: 'An open supplier bill is overdue or due within the lead time.',
  defaultEnabled: true,
  evaluate(ctx, prefs): NotificationCandidate[] {
    let rows;
    try {
      rows = ctx.loadParties();
    } catch {
      return [];
    }
    const out: NotificationCandidate[] = [];
    for (const row of rows) {
      for (const bill of row.openBills || []) {
        if (bill.kind !== 'bill') continue;
        const outstanding = Number(bill.outstanding) || 0;
        if (!(outstanding > 0)) continue;
        const days = daysBetween(ctx.todayAD, bill.due);
        if (days === null || days > prefs.dueSoonDays) continue;
        const short = String(bill.id || '').slice(0, 14);
        const when =
          days < 0 ? 'is overdue' : days === 0 ? 'is due today' : `is due in ${plural(days, 'day')}`;
        out.push({
          dedupeKey: notificationKey('bill-due', ctx.projectId, bill.id, bill.due),
          kind: 'bill',
          severity: days <= -30 ? 'critical' : 'warning',
          title: `Supplier bill ${short} ${when}`,
          body: `${row.party_id || 'Supplier'} · ${money(outstanding)} · due ${bill.due}`,
          action: { page: 'ledger', entityId: bill.id },
          meta: { due: bill.due, outstanding: String(outstanding), party: row.party_id || '' },
        });
      }
    }
    return out;
  },
};
