import { cumulativeMap } from '../../dsrService';
import type { NotificationCandidate, NotificationRule } from '../types';
import { notificationKey, percent, quantity } from './helpers';
import { boqEstimates } from './boqOverrun';

/**
 * A code that is nearly used up (95–99%). Off by default: it is useful on a
 * measured job and noisy on a lump-sum one.
 */
export const boqNearlyRule: NotificationRule = {
  id: 'boq-nearly',
  kind: 'boq',
  label: 'BOQ nearly used up',
  description: 'A code has reached 95% of its BOQ quantity but not gone over.',
  defaultEnabled: false,
  evaluate(ctx): NotificationCandidate[] {
    const done = cumulativeMap(ctx.dsr);
    const month = ctx.todayAD.slice(0, 7);
    const out: NotificationCandidate[] = [];
    for (const estimate of boqEstimates(ctx.boq)) {
      const qty = done.get(estimate.code.trim().toLowerCase()) || 0;
      const pct = percent(qty, estimate.estimated);
      if (pct < 95 || pct >= 100) continue;
      out.push({
        dedupeKey: notificationKey('boq-nearly', ctx.projectId, estimate.code, month),
        kind: 'boq',
        severity: 'info',
        title: `BOQ ${estimate.code} is at ${pct}%`,
        body: `${quantity(qty)} of ${quantity(estimate.estimated)} ${estimate.unit} used. Only ${quantity(estimate.estimated - qty)} ${estimate.unit} left.`,
        action: { page: 'boq', entityId: estimate.code },
        meta: { code: estimate.code, done: String(qty), estimated: String(estimate.estimated) },
      });
    }
    return out;
  },
};
