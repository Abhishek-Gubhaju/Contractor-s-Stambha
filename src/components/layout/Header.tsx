import {
  Bell,
  Moon,
  Sun,
  Menu,
  LogOut,
  Lock,
  User,
  ChevronDown,
  HelpCircle,
  RefreshCw,
  Cog,
  Building2,
  Plus,
  Check,
  AlertTriangle,
  ClipboardList,
  FileText,
  Users,
  DollarSign,
  Clock,
  CheckCircle,
  X,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { cn } from '../../utils';
import { loadProjects, projectNameOf, upsertProject } from '../../services/masterData';
import { setActiveProject, useActiveProject } from '../../services/projectScope';
import type { AppNotification, NotificationKind } from '../../services/notifications/types';
import { KIND_LABEL, relativeTime, SEVERITY_DOT } from '../../services/notifications/format';

interface HeaderProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  currentPage: string;
  onNavigate?: (page: string) => void;
  onRefresh?: () => void;
  onLogout?: () => void;
  onLock?: () => void;
  userName?: string;
  userAccount?: string;
  notifications?: AppNotification[];
  notificationsUnread?: number;
  notificationsError?: string;
  onMarkNotificationRead?: (id: string) => void;
  onMarkAllNotificationsRead?: () => void;
  onDismissNotification?: (id: string) => void;
  onSnoozeNotification?: (id: string, days: number) => void;
}

function NotificationIcon({ kind }: { kind: NotificationKind }) {
  const className = 'w-4 h-4';
  switch (kind) {
    case 'dsr':
      return <ClipboardList className={className} />;
    case 'boq':
      return <FileText className={className} />;
    case 'bill':
    case 'invoice':
      return <DollarSign className={className} />;
    case 'stock':
      return <FileText className={className} />;
    case 'payroll':
    case 'staff':
      return <Users className={className} />;
    case 'schedule':
      return <Clock className={className} />;
    case 'backup':
      return <CheckCircle className={className} />;
    default:
      return <AlertTriangle className={className} />;
  }
}

export function Header({
  isSidebarCollapsed,
  onToggleSidebar,
  currentPage,
  onNavigate,
  onRefresh,
  onLogout,
  onLock,
  userName,
  userAccount,
  notifications = [],
  notificationsUnread = 0,
  notificationsError,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  onDismissNotification,
  onSnoozeNotification,
}: HeaderProps) {
  // Read the saved preference up front so the first effect run doesn't
  // overwrite it with the default before it has been loaded.
  const [isDarkMode, setIsDarkMode] = useState(() => {
    try {
      return localStorage.getItem('darkMode') === 'true';
    } catch {
      return false;
    }
  });
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProject, setNewProject] = useState({ id: '', name: '' });
  const activeProject = useActiveProject();
  const projects = loadProjects();
  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);

  // Toggle dark mode — keep light/dark mutually exclusive so the pre-paint
  // theme rules in index.html can never both match.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkMode);
    root.classList.toggle('light', !isDarkMode);
    root.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    try {
      localStorage.setItem('darkMode', String(isDarkMode));
    } catch {
      /* storage unavailable — preference just won't persist */
    }
  }, [isDarkMode]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Global "＋ New Entry" shortcut (S2.1) now lives only on the Ledger page —
  // the header no longer shows the capture button or listens for the shortcut.

  // 'job-costing' -> 'Job Costing', 'boq' -> 'BOQ', 'dsr' -> 'DSR'
  const pageTitle =
    currentPage === 'vault'
      ? 'File Vault'
      : /^(boq|dsr)$/.test(currentPage)
        ? currentPage.toUpperCase()
        : currentPage
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

  // Escape closes the notification popover like every other menu here.
  useEffect(() => {
    if (!showNotifications) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowNotifications(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showNotifications]);

  const latestNotifications = notifications.slice(0, 8);

  const createProject = () => {
    try {
      const created = upsertProject({
        id: newProject.id,
        name: newProject.name || newProject.id,
        client: '',
        status: 'active',
        startDate: '',
        endDate: '',
      });
      setActiveProject(created.id);
      setShowNewProject(false);
      setShowProjectMenu(false);
      setNewProject({ id: '', name: '' });
    } catch {
      /* upsertProject validates the job number; the field stays for correction */
    }
  };

  return (
    <header
      className="relative z-30 h-16 w-full shrink-0 bg-white border-b border-gray-200"
    >
      <div className="flex items-center justify-between h-full px-4 sm:px-6">
        {/* Left side - Menu toggle and page title */}
        <div className="flex items-center gap-4">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors lg:hidden"
            aria-label="Toggle menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold text-gray-900 hidden sm:block">{pageTitle}</h1>
        </div>

        {/* Right side - Actions */}
        <div className="flex items-center gap-2">
          {/* Active project — every operational dataset is scoped to it. */}
          <div className="relative">
            <button
              onClick={() => setShowProjectMenu((v) => !v)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              aria-label="Active project"
              aria-expanded={showProjectMenu}
            >
              <Building2 className="w-4 h-4 text-gray-500 shrink-0" />
              <span className="hidden sm:flex flex-col items-start leading-tight min-w-0">
                <span className="text-xs font-semibold text-gray-900 font-mono">{activeProject}</span>
                <span className="text-[11px] text-gray-500 max-w-[12rem] truncate">{projectNameOf(activeProject)}</span>
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            </button>

            {showProjectMenu && (
              <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                <div className="px-3 py-2 border-b border-gray-200">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Project</p>
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setActiveProject(p.id); setShowProjectMenu(false); }}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50',
                        p.id === activeProject && 'bg-gray-100 text-gray-900'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-gray-500">{p.id}</span>
                        <span className="block truncate">{p.name}</span>
                      </span>
                      {p.id === activeProject && <Check className="w-4 h-4 text-accent shrink-0" />}
                    </button>
                  ))}
                </div>
                <div className="border-t border-gray-200 p-2">
                  {showNewProject ? (
                    <div className="space-y-2">
                      <input
                        value={newProject.id}
                        onChange={(e) => setNewProject({ ...newProject, id: e.target.value })}
                        placeholder="PRJ-002"
                        aria-label="New project number"
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                      <input
                        value={newProject.name}
                        onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                        placeholder="Project name"
                        aria-label="New project name"
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                      <div className="flex gap-2">
                        <button onClick={createProject} className="flex-1 bg-gray-900 hover:bg-gray-800 text-white text-sm rounded px-2 py-1.5">Create &amp; switch</button>
                        <button
                          onClick={() => { setShowNewProject(false); setNewProject({ id: '', name: '' }); }}
                          className="px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewProject(true)}
                      className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-900 hover:bg-gray-100 rounded px-2 py-2"
                    >
                      <Plus className="w-4 h-4" /> New project
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Refresh button */}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              aria-label="Refresh data"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          )}

          {/* Dark mode toggle */}
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          {/* Notifications — a real inbox, not a decorative bell. */}
          <div className="relative" ref={notificationsRef}>
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors relative"
              aria-label={notificationsUnread > 0 ? `Notifications, ${notificationsUnread} unread` : 'Notifications'}
              aria-expanded={showNotifications}
              data-testid="notifications-bell"
            >
              <Bell className="w-5 h-5" />
              {notificationsUnread > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 rounded-full bg-gray-900 text-white text-[10px] font-semibold leading-4 text-center"
                  data-testid="notification-dot"
                >
                  {notificationsUnread > 9 ? '9+' : notificationsUnread}
                </span>
              )}
            </button>

            {showNotifications && (
              <div
                className="absolute right-0 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden"
                data-testid="notifications-panel"
                role="region"
                aria-label="Notifications"
              >
                <div className="px-4 py-2.5 border-b border-gray-200">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-gray-900">Notifications</h3>
                      <p className="text-[11px] text-gray-500" data-testid="notifications-panel-count">
                        {notificationsUnread > 0 ? `${notificationsUnread} unread` : 'You are all caught up'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onMarkAllNotificationsRead?.()}
                      disabled={notificationsUnread === 0}
                      data-testid="notifications-mark-all"
                      className="text-xs font-medium text-gray-700 hover:text-gray-900 disabled:text-gray-300 disabled:cursor-default"
                    >
                      Mark all read
                    </button>
                  </div>
                </div>

                {notificationsError && (
                  <p role="alert" className="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">
                    {notificationsError}
                  </p>
                )}

                <div className="max-h-80 overflow-y-auto">
                  {latestNotifications.length === 0 ? (
                    <div className="px-4 py-7 text-center">
                      <Bell className="w-5 h-5 mx-auto text-gray-300" />
                      <p className="mt-1.5 text-sm text-gray-600">No notifications. You're all caught up.</p>
                    </div>
                  ) : (
                    latestNotifications.map((notification) => (
                      <div
                        key={notification.id}
                        data-testid={`notification-${notification.id}`}
                        className={cn(
                          'px-3 py-2 border-b border-gray-100 last:border-b-0',
                          !notification.readAt && 'bg-gray-50'
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={cn('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', SEVERITY_DOT[notification.severity])}
                            aria-hidden="true"
                          />
                          <span className="text-gray-500 mt-0.5 shrink-0">
                            <NotificationIcon kind={notification.kind} />
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              onMarkNotificationRead?.(notification.id);
                              onNavigate?.(notification.action.page);
                              setShowNotifications(false);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <span className="block text-sm font-medium text-gray-900 break-words">
                              {notification.title}
                            </span>
                            <span className="block text-xs text-gray-600 mt-0.5 break-words">
                              {notification.body}
                            </span>
                            <span className="block text-[11px] text-gray-400 mt-1">
                              {KIND_LABEL[notification.kind]} · {relativeTime(notification.createdAt)}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Dismiss ${notification.title}`}
                            title="Dismiss"
                            onClick={() => onDismissNotification?.(notification.id)}
                            className="p-1 -mr-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="mt-1.5 ml-7">
                          <select
                            aria-label={`Snooze ${notification.title}`}
                            value=""
                            onChange={(event) => {
                              const days = Number(event.target.value);
                              if (days > 0) onSnoozeNotification?.(notification.id, days);
                            }}
                            className="text-[11px] text-gray-500 border border-gray-200 rounded px-1.5 py-0.5 bg-white"
                          >
                            <option value="">Snooze…</option>
                            <option value="1">1 day</option>
                            <option value="3">3 days</option>
                            <option value="7">1 week</option>
                          </select>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="px-3 py-2 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={() => {
                      setShowNotifications(false);
                      onNavigate?.('notifications');
                    }}
                    data-testid="notifications-view-all"
                    className="w-full text-left text-sm text-accent hover:text-blue-700"
                  >
                    View all notifications
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Help */}
          <button
            className="p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Help"
          >
            <HelpCircle className="w-5 h-5" />
          </button>

          {/* User Menu */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 p-1.5 pr-3 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="User menu"
              aria-expanded={showUserMenu}
            >
              <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                <User className="w-5 h-5 text-gray-600" />
              </div>
              <span className="hidden md:block text-sm font-medium text-gray-700">{userName || 'Admin'}</span>
              <ChevronDown className="w-4 h-4 text-gray-500 hidden md:block" />
            </button>

            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                <div className="px-4 py-2 border-b border-gray-200">
                  <p className="text-sm font-medium text-gray-900">{userName || 'Admin User'}</p>
                  {userAccount && <p className="text-xs text-gray-500">{userAccount}</p>}
                </div>
                <button
                  onClick={() => { onNavigate?.('settings'); setShowUserMenu(false); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <Cog className="w-4 h-4" />
                  Settings
                </button>
                {onLock && (
                  <button
                    onClick={() => { onLock(); setShowUserMenu(false); }}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <Lock className="w-4 h-4" />
                    Lock
                  </button>
                )}
                {onLogout && (
                  <>
                    <hr className="my-1 border-gray-200" />
                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        // One shared flow: offers a backup, then signs out.
                        onLogout();
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}