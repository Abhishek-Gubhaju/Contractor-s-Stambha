import { createContext, useContext, useState, ReactNode, HTMLAttributes } from 'react';

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  variant?: 'line' | 'enclosed' | 'soft';
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within a Tabs provider');
  }
  return context;
}

interface TabsProps {
  defaultValue: string;
  value?: string;
  onChange?: (value: string) => void;
  variant?: 'line' | 'enclosed' | 'soft';
  children: ReactNode;
  className?: string;
}

export function Tabs({ defaultValue, value, onChange, variant = 'line', children, className = '' }: TabsProps) {
  const [activeTab, setActiveTab] = useState(value || defaultValue);

  const handleTabChange = (tab: string) => {
    if (value === undefined) {
      setActiveTab(tab);
    }
    onChange?.(tab);
  };

  const contextValue = {
    activeTab: value ?? activeTab,
    setActiveTab: handleTabChange,
    variant,
  };

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps extends HTMLAttributes<HTMLDivElement> {}

export function TabsList({ className = '', children, ...props }: TabsListProps) {
  const { variant = 'line' } = useTabsContext();

  const baseClasses = 'flex gap-1';
  const variantClasses = {
    line: 'border-b border-gray-200',
    enclosed: '',
    soft: '',
  };

  return (
    <div
      role="tablist"
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

interface TabsTriggerProps extends HTMLAttributes<HTMLButtonElement> {
  value: string;
  disabled?: boolean;
}

export function TabsTrigger({ value, disabled = false, className = '', children, ...props }: TabsTriggerProps) {
  const { activeTab, setActiveTab, variant = 'line' } = useTabsContext();
  const isActive = activeTab === value;

  const baseClasses = `
    px-4 py-2 text-sm font-medium rounded-t-lg transition-all duration-200
    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
    disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const variantClasses = {
    line: isActive
      ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50',
    enclosed: isActive
      ? 'bg-blue-600 text-white shadow-sm'
      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100',
    soft: isActive
      ? 'bg-blue-100 text-blue-700'
      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50',
  };

  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${value}`}
      id={`tab-${value}`}
      value={value}
      onClick={() => !disabled && setActiveTab(value)}
      disabled={disabled}
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className = '', children, ...props }: TabsContentProps) {
  const { activeTab } = useTabsContext();
  const isActive = activeTab === value;

  if (!isActive) return null;

  return (
    <div
      role="tabpanel"
      id={`panel-${value}`}
      aria-labelledby={`tab-${value}`}
      className={`${className}`}
      {...props}
    >
      {children}
    </div>
  );
}