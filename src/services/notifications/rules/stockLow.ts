import type { NotificationCandidate, NotificationRule } from '../types';
import { notificationKey, quantity } from './helpers';

/** Stock at or below its reorder level. Items with no level are ignored. */
export const stockLowRule: NotificationRule = {
  id: 'stock-low',
  kind: 'stock',
  label: 'Stock at reorder level',
  description: 'An inventory item has reached or fallen below its reorder level.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const out: NotificationCandidate[] = [];
    for (const row of ctx.stock) {
      const level = Number(row.item.reorderLevel) || 0;
      if (!(level > 0)) continue;
      if (row.qty > level) continue;
      const unit = row.item.unit ? ` ${row.item.unit}` : '';
      out.push({
        dedupeKey: notificationKey('stock-low', ctx.projectId, row.item.id, String(level)),
        kind: 'stock',
        severity: 'warning',
        title: `${row.item.name} is at its reorder level`,
        body: `On hand ${quantity(row.qty)}${unit}; reorder at ${quantity(level)}${unit}.`,
        action: { page: 'inventory', entityId: row.item.id },
        meta: {
          item: row.item.name,
          qty: String(row.qty),
          reorderLevel: String(level),
        },
      });
    }
    return out;
  },
};
