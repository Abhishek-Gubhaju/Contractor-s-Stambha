// The complete rule registry. Order is presentation order in preferences.
import type { NotificationRule, NotificationRuleId } from '../types';
import { dsrDraftRule } from './dsrDraft';
import { dsrApprovalRule } from './dsrApproval';
import { dsrMissingRule } from './dsrMissing';
import { boqOverrunRule } from './boqOverrun';
import { boqNearlyRule } from './boqNearly';
import { billDueRule } from './billDue';
import { invoiceDueRule } from './invoiceDue';
import { stockLowRule } from './stockLow';
import { payrollUnpaidRule } from './payrollUnpaid';
import { staffLeaveRule } from './staffLeave';
import { scheduleLateRule } from './scheduleLate';
import { backupStaleRule } from './backupStale';

export const NOTIFICATION_RULES: NotificationRule[] = [
  dsrDraftRule,
  dsrApprovalRule,
  dsrMissingRule,
  boqOverrunRule,
  boqNearlyRule,
  billDueRule,
  invoiceDueRule,
  stockLowRule,
  payrollUnpaidRule,
  staffLeaveRule,
  scheduleLateRule,
  backupStaleRule,
];

const byId = new Map<NotificationRuleId, NotificationRule>(
  NOTIFICATION_RULES.map((rule) => [rule.id, rule] as const)
);

export function notificationRule(id: NotificationRuleId): NotificationRule | undefined {
  return byId.get(id);
}
