import { useState } from 'react';
import { LayoutDashboard, FileText, Calculator, ClipboardList, Users, DollarSign, TrendingUp, BookOpen, Calendar, Settings, ChevronLeft, ChevronRight, Home, FileSpreadsheet, HardHat, ClipboardCheck, UserCheck, CreditCard, Activity, FileBarChart, CalendarDays, UserCog, Cog, Package, FolderOpen } from 'lucide-react';
import { cn } from '../../utils';
import appIcon from '../../assets/app-icon.svg';

interface NavItemType {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  page: string;
}

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  currentPage: string;
  onPageChange: (page: string) => void;
}

const navigationItems: NavItemType[] = [
  { label: 'Dashboard', icon: LayoutDashboard, page: 'dashboard' },
  { label: 'BOQ', icon: FileSpreadsheet, page: 'boq' },
  { label: 'Job Costing', icon: Calculator, page: 'job-costing' },
  { label: 'DSR', icon: ClipboardCheck, page: 'dsr' },
  { label: 'Attendance', icon: UserCheck, page: 'attendance' },
  { label: 'Billing', icon: CreditCard, page: 'billing' },
  { label: 'Commitments', icon: ClipboardList, page: 'commitments' },
  { label: 'Inventory', icon: Package, page: 'inventory' },
  { label: 'Work Progress', icon: Activity, page: 'work-progress' },
  { label: 'Ledger', icon: BookOpen, page: 'ledger' },
  { label: 'Financials', icon: TrendingUp, page: 'financials' },
  { label: 'Gantt Chart', icon: FileBarChart, page: 'gantt' },
  { label: 'File Vault', icon: FolderOpen, page: 'vault' },
  { label: 'Staff Info', icon: UserCog, page: 'staff-info' },
  { label: 'Settings', icon: Cog, page: 'settings' },
];

export function Sidebar({ isCollapsed, onToggle, currentPage, onPageChange }: SidebarProps) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  return (
    <aside
      className={cn(
        // A flex sibling (not a fixed overlay), so the main column always resizes
        // with it: nothing is ever covered. The nav scrolls, the footer pins.
        'relative z-40 h-full shrink-0 bg-white border-r border-gray-200 transition-all duration-300 ease-in-out flex flex-col overflow-hidden',
        isCollapsed ? 'w-16' : 'w-64'
      )}
      onMouseEnter={() => setHoveredItem(null)}
      onMouseLeave={() => setHoveredItem(null)}
    >
      {/* Logo / Brand */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
        {!isCollapsed && (
          <div className="flex items-center gap-3">
            <img src={appIcon} alt="" className="w-8 h-8" />
            <span className="font-bold text-gray-900 text-lg">Stambha</span>
          </div>
        )}
        <button
          onClick={onToggle}
          className={cn(
            'p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors',
            isCollapsed && 'mx-auto'
          )}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Main navigation">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentPage === item.page;
          const isHovered = hoveredItem === item.page;

          return (
            <button
              key={item.page}
              onClick={() => onPageChange(item.page)}
              onMouseEnter={() => setHoveredItem(item.page)}
              onMouseLeave={() => setHoveredItem(null)}
              className={cn(
                'relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                isActive
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
                isCollapsed && 'justify-center px-2'
              )}
              title={isCollapsed ? item.label : undefined}
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" aria-hidden="true" />
              )}
              <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-accent')} aria-hidden="true" />
              {!isCollapsed && <span className="truncate">{item.label}</span>}
              {isCollapsed && isHovered && (
                <span className="absolute left-16 top-2.5 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap shadow-lg z-50">
                  {item.label}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200">
        {!isCollapsed && (
          <div className="text-xs text-gray-500 text-center">
            Stambha Desktop v1.0.0
          </div>
        )}
      </div>
    </aside>
  );
}