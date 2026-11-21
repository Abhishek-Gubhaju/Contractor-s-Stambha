import { STAFF_LEAVE_LIMIT } from '../../staffAttendanceService';
import type { NotificationCandidate, NotificationRule } from '../types';
import { notificationKey, plural } from './helpers';

/** Staff past the monthly leave allowance. Salary is never changed by this. */
export const staffLeaveRule: NotificationRule = {
  id: 'staff-leave',
  kind: 'staff',
  label: 'Staff over the leave limit',
  description: 'A staff member has used more leave days than the monthly allowance.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const month = ctx.todayAD.slice(0, 7);
    return ctx.staffLeave.map((row) => ({
      dedupeKey: notificationKey('staff-leave', ctx.projectId, row.staff_id, month),
      kind: 'staff' as const,
      severity: 'info' as const,
      title: `${row.name} is over the leave limit`,
      body: `${plural(row.leave, 'leave day')} this month (limit ${STAFF_LEAVE_LIMIT}). Salary is unchanged.`,
      action: { page: 'staff-info', entityId: row.staff_id },
      meta: { staffId: row.staff_id, leave: String(row.leave), month },
    }));
  },
};
