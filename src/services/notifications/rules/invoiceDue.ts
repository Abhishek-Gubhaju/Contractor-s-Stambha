import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, money, notificationKey, plural } from './helpers';

/** A client invoice still open and due within the lead time, or overdue. */
export const invoiceDueRule: NotificationRule = {
  id: 'invoice-due',
  kind: 'invoice',
  label: 'Client invoices due',
  description: 'An open client invoice is overdue or due within the lead time.',
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
      for (const invoice of row.openBills || []) {
        if (invoice.kind !== 'invoice') continue;
        const outstanding = Number(invoice.outstanding) || 0;
        if (!(outstanding > 0)) continue;
        const days = daysBetween(ctx.todayAD, invoice.due);
        if (days === null || days > prefs.dueSoonDays) continue;
        const short = String(invoice.id || '').slice(0, 14);
        const when =
          days < 0 ? 'is overdue' : days === 0 ? 'is due today' : `is due in ${plural(days, 'day')}`;
        out.push({
          dedupeKey: notificationKey('invoice-due', ctx.projectId, invoice.id, invoice.due),
          kind: 'invoice',
          severity: days <= -30 ? 'critical' : 'warning',
          title: `Client invoice ${short} ${when}`,
          body: `${row.party_id || 'Client'} · ${money(outstanding)} · due ${invoice.due}`,
          action: { page: 'ledger', entityId: invoice.id },
          meta: { due: invoice.due, outstanding: String(outstanding), party: row.party_id || '' },
        });
      }
    }
    return out;
  },
};
