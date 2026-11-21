import { cumulativeMap } from '../../dsrService';
import type { AppBOQSection } from '../../../types';
import type { NotificationCandidate, NotificationRule } from '../types';
import { notificationKey, percent, quantity } from './helpers';

interface Estimate {
  code: string;
  description: string;
  unit: string;
  estimated: number;
}

/** Estimated quantity per BOQ code, summed across sections. */
export function boqEstimates(boq: AppBOQSection[]): Estimate[] {
  const byCode = new Map<string, Estimate>();
  for (const section of Array.isArray(boq) ? boq : []) {
    for (const item of section?.children || []) {
      const code = String(item?.itemCode || '').trim();
      const estimated = Number(item?.estimatedQuantity) || 0;
      if (!code || estimated <= 0) continue;
      const key = code.toLowerCase();
      const row = byCode.get(key);
      if (row) row.estimated += estimated;
      else
        byCode.set(key, {
          code,
          description: String(item?.description || ''),
          unit: String(item?.unit || ''),
          estimated,
        });
    }
  }
  return [...byCode.values()];
}

/** Work recorded above the BOQ estimate — a contract-risk signal. */
export const boqOverrunRule: NotificationRule = {
  id: 'boq-overrun',
  kind: 'boq',
  label: 'BOQ quantity overrun',
  description: 'Work recorded on a code is above its BOQ quantity.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const done = cumulativeMap(ctx.dsr);
    const out: NotificationCandidate[] = [];
    for (const estimate of boqEstimates(ctx.boq)) {
      const qty = done.get(estimate.code.trim().toLowerCase()) || 0;
      if (!(qty > estimate.estimated + 0.0001)) continue;
      const pct = percent(qty, estimate.estimated);
      out.push({
        dedupeKey: notificationKey('boq-overrun', ctx.projectId, estimate.code),
        kind: 'boq',
        severity: 'critical',
        title: `BOQ ${estimate.code} is over its quantity`,
        body: `${quantity(qty)} of ${quantity(estimate.estimated)} ${estimate.unit} recorded (${pct}%). Check the variation before billing it.`,
        action: { page: 'boq', entityId: estimate.code },
        meta: { code: estimate.code, done: String(qty), estimated: String(estimate.estimated) },
      });
    }
    return out;
  },
};
