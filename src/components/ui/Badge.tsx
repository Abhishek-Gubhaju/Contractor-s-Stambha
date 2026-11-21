import { HTMLAttributes, forwardRef } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  dot?: boolean;
}

const variantClasses = {
  default: 'bg-gray-100 text-gray-700',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-gray-100 text-gray-700',
  secondary: 'bg-gray-100 text-gray-600',
};

const sizeClasses = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

const dotColors = {
  default: 'bg-gray-400',
  success: 'bg-green-600',
  warning: 'bg-amber-600',
  danger: 'bg-red-600',
  info: 'bg-gray-500',
  secondary: 'bg-gray-400',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className = '', variant = 'default', size = 'md', dot = false, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={`
          inline-flex items-center gap-1.5 font-medium rounded-full
          ${variantClasses[variant]}
          ${sizeClasses[size]}
          ${className}
        `}
        {...props}
      >
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dotColors[variant]}`} />}
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';