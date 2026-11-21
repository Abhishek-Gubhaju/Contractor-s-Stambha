import React from 'react';
import { Sidebar, Header } from './components/layout';
// Pages are loaded on demand so the first paint only downloads the dashboard.
// Heavy dependencies (e.g. the xlsx library used by BOQ/Attendance) stay out
// of the initial bundle.
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const BOQPage = React.lazy(() => import('./pages/BOQ'));
const JobCostingPage = React.lazy(() => import('./pages/JobCosting'));
const DSRPage = React.lazy(() => import('./pages/DSR'));
const AttendancePage = React.lazy(() => import('./pages/Attendance'));
const BillingPage = React.lazy(() => import('./pages/Billing'));
const CommitmentsPage = React.lazy(() => import('./pages/Commitments'));
const InventoryPage = React.lazy(() => import('./pages/Inventory'));
const WorkProgressPage = React.lazy(() => import('./pages/WorkProgress'));
const LedgerPage = React.lazy(() => import('./pages/Ledger'));
const FinancialsPage = React.lazy(() => import('./pages/Financials'));
const GanttPage = React.lazy(() => import('./pages/Gantt'));
const FileVaultPage = React.lazy(() => import('./pages/FileVault'));
const StaffInfoPage = React.lazy(() => import('./pages/StaffInfo'));
const SettingsPage = React.lazy(() => import('./pages/Settings'));
const NotificationsPage = React.lazy(() => import('./pages/Notifications'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-live="polite">
      <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
import { useLocalStorage } from './hooks';
import { getCurrentMonthInTimezone } from './utils';
import { AppBOQSection, AppLaborer, AppPurchaseOrder, AppDSRRecord, AppMilestone, AppStaffMember } from './types';

type PageType = 'dashboard' | 'boq' | 'job-costing' | 'dsr' | 'attendance' | 'billing' | 'commitments' | 'inventory' | 'work-progress' | 'ledger' | 'financials' | 'gantt' | 'vault' | 'staff-info' | 'notifications' | 'settings';

import { migrateProjectScope, readScoped, useActiveProject, useScopedLocalStorage } from './services/projectScope';
import { DialogHost, notify } from './components/ui/DialogHost';
import { runBackup } from './services/backup/backupService';
import { isDesktopApp } from './services/backup/desktop';
import { useAuth } from './services/auth/useAuth';
import { useNotifications } from './hooks/useNotifications';
import { refreshNotifications, startNotificationWatcher } from './services/notifications/sync';
import { lockSession, signOut } from './services/auth/authService';
import { requestSignOut } from './services/auth/signOutFlow';
import { startAutoBackupWatcher } from './services/backup/autoBackup';
import { watchCloseRequests } from './services/app/closeFlow';
import { startMirrorSync } from './services/storage/mirror';
import { printCurrentTarget } from './services/print/printService';

// Adopt pre-scope data into the original job once, before any scoped read.
migrateProjectScope();

export default function App() {
  const [currentPage, setCurrentPage] = React.useState<PageType>('dashboard');
  // Narrow windows start collapsed so the content column is never squeezed;
  // the toggle still works at every width.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const auth = useAuth();
  const notifications = useNotifications();
  // Notifications: one initial pass (no toast on launch), then a watcher that
  // follows saves, the active job and returning to the window.
  React.useEffect(() => {
    const stop = startNotificationWatcher();
    void refreshNotifications(Date.now(), { toast: false }).catch(() => {
      /* opening the app must never fail because a rule did */
    });
    return stop;
  }, []);
  // Desktop: keep a fresh backup while the app is open, and turn a window
  // close or Cmd+Q into a "back up first?" checkpoint.
  React.useEffect(() => {
    const stopWatcher = startAutoBackupWatcher();
    // Every save also lands in a durable native file, with one previous copy.
    const stopMirror = startMirrorSync();
    let stopClose: (() => void) | undefined;
    let cancelled = false;
    void watchCloseRequests().then((off) => {
      if (cancelled) off();
      else stopClose = off;
    });
    return () => {
      cancelled = true;
      stopWatcher();
      stopMirror();
      stopClose?.();
    };
  }, []);
  const activeProject = useActiveProject();
  // Every dataset starts empty: a new account (and a new job) opens a clean
  // workspace rather than sample records that have to be deleted first.
  const [boqData, setBoqData] = useScopedLocalStorage<AppBOQSection[]>('contractoros_boq', []);
  const [laborData, setLaborData] = useScopedLocalStorage<AppLaborer[]>('contractoros_labor', []);
  const [poData, setPoData] = useScopedLocalStorage<AppPurchaseOrder[]>('contractoros_po', []);
  const [dsrData, setDsrData] = useScopedLocalStorage<AppDSRRecord[]>('contractoros_dsr', []);
  const [milestones, setMilestones] = useScopedLocalStorage<AppMilestone[]>('contractoros_milestones', []);
  const [timezone, setTimezone] = useLocalStorage<string>('contractoros_settings_timezone', 'Asia/Kathmandu');
  const [staffData, setStaffData] = useScopedLocalStorage<AppStaffMember[]>('contractoros_staff', []);
  const [deletedStaff, setDeletedStaff] = useScopedLocalStorage<AppStaffMember[]>('contractoros_staff_deleted', []);
  const [billingEntries, setBillingEntries] = useScopedLocalStorage<any[]>('contractoros_billing_entries', []);

  // Native menu → the same actions the UI uses. Backup needs the webview's
  // data, so the menu emits and this listener runs runBackup().
  React.useEffect(() => {
    if (!isDesktopApp()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen('menu:backup-now', async () => {
        try {
          const result = await runBackup();
          notify(`Backup written: ${result.fileCount} files → ${result.location}`);
        } catch (e) {
          notify(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Native File → Print (Cmd+P). The page registers the sheet it wants printed
  // (voucher, DSR, register, ledger view, chart); this prints exactly that.
  React.useEffect(() => {
    if (!isDesktopApp()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen('menu:print', () => {
        void printCurrentTarget();
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Postings write actuals back into the BOQ document; refresh the shared
  // state so Job Costing shows them without a reload.
  React.useEffect(() => {
    const refresh = () => {
      // Must read through the project scope and the account namespace: the
      // bare key is neither, so the old read silently skipped every update
      // once data moved to `contractoros_boq::<PROJECT>`.
      setBoqData(readScoped<AppBOQSection[]>('contractoros_boq', []));
    };
    window.addEventListener('contractoros:boq-changed', refresh);
    return () => window.removeEventListener('contractoros:boq-changed', refresh);
  }, [setBoqData]);

  const yearMonth = React.useMemo(() => {
    const [y, m] = getCurrentMonthInTimezone(timezone).split('-');
    return { year: y, month: parseInt(m, 10) };
  }, [timezone]);

  // Stable callbacks so memoised children don't re-render on every App render.
  const navigate = React.useCallback((page: string) => setCurrentPage(page as PageType), []);
  const toggleSidebar = React.useCallback(() => setIsSidebarCollapsed((c) => !c), []);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={toggleSidebar}
        currentPage={currentPage}
        onPageChange={navigate}
      />
      {/* The sidebar is a flex sibling, so this column resizes with it instead
          of being covered by a fixed overlay. */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          currentPage={currentPage}
          onNavigate={navigate}
          userName={auth.user?.displayName}
          userAccount={auth.user ? `@${auth.user.username}` : undefined}
          notifications={notifications.active}
          notificationsUnread={notifications.unread}
          notificationsError={notifications.error}
          onMarkNotificationRead={notifications.markRead}
          onMarkAllNotificationsRead={notifications.markAllRead}
          onDismissNotification={notifications.dismiss}
          onSnoozeNotification={notifications.snooze}
          onLock={auth.user ? () => lockSession() : undefined}
          onLogout={auth.user ? () => { void requestSignOut(); } : undefined}
        />
        <main key={activeProject} className="flex-1 overflow-y-auto p-4 lg:p-6">
          <React.Suspense fallback={<PageLoader />}>
          {currentPage === 'dashboard' && <Dashboard poData={poData} timezone={timezone} boqData={boqData} laborData={laborData} dsrData={dsrData} billingEntries={billingEntries} userName={auth.user?.displayName} />}
          {currentPage === 'boq' && <BOQPage boqData={boqData} setBoqData={setBoqData} />}
          {currentPage === 'job-costing' && <JobCostingPage boqData={boqData} dsrData={dsrData} />}
          {currentPage === 'dsr' && <DSRPage dsrData={dsrData} setDsrData={setDsrData} boqData={boqData} laborData={laborData} timezone={timezone} onNavigate={navigate} />}
          {currentPage === 'attendance' && <AttendancePage laborData={laborData} setLaborData={setLaborData} timezone={timezone} staffData={staffData} />}
          {currentPage === 'billing' && <BillingPage billingEntries={billingEntries} setBillingEntries={setBillingEntries} yearMonth={yearMonth} timezone={timezone} />}
          {currentPage === 'commitments' && <CommitmentsPage />}
          {currentPage === 'inventory' && <InventoryPage />}
          {currentPage === 'work-progress' && <WorkProgressPage boqData={boqData} dsrData={dsrData} milestones={milestones} setMilestones={setMilestones} timezone={timezone} />}
          {currentPage === 'ledger' && <LedgerPage onNavigate={navigate} />}
          {currentPage === 'financials' && <FinancialsPage />}
          {currentPage === 'gantt' && <GanttPage boqData={boqData} dsrData={dsrData} milestones={milestones} timezone={timezone} />}
          {currentPage === 'vault' && <FileVaultPage />}
          {currentPage === 'staff-info' && <StaffInfoPage staffData={staffData} setStaffData={setStaffData} deletedStaff={deletedStaff} setDeletedStaff={setDeletedStaff} />}
          {currentPage === 'notifications' && <NotificationsPage onNavigate={navigate} />}
          {currentPage === 'settings' && <SettingsPage timezone={timezone} setTimezone={setTimezone} />}
          </React.Suspense>
        </main>
      </div>
      <DialogHost />
    </div>
  );
}
