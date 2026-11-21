import { useState, ReactNode, HTMLAttributes, forwardRef } from 'react';

export interface TooltipProps extends Omit<HTMLAttributes<HTMLDivElement>, 'content'> {
  content: ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const positionClasses = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

const arrowClasses = {
  top: 'border-t-gray-900',
  bottom: 'border-b-gray-900',
  left: 'border-l-gray-900',
  right: 'border-r-gray-900',
};

export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(
  ({ content, children, position = 'top', delay = 200, className = '', ...props }, ref) => {
    const [isVisible, setIsVisible] = useState(false);
    let timeoutId: ReturnType<typeof setTimeout>;

    const showTooltip = () => {
      timeoutId = setTimeout(() => setIsVisible(true), delay);
    };

    const hideTooltip = () => {
      clearTimeout(timeoutId);
      setIsVisible(false);
    };

    return (
      <div
        ref={ref}
        className={`relative inline-block ${className}`}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        {...props}
      >
        {children}
        {isVisible && (
          <div
            className={`
              absolute z-50 px-3 py-2 text-xs font-medium text-white bg-gray-900 rounded-lg shadow-lg
              whitespace-nowrap opacity-0 animate-fade-in
              ${positionClasses[position]}
            `}
            role="tooltip"
          >
            {content}
            <div
              className={`
                absolute w-0 h-0 border-4 border-transparent
                ${position === 'top' && 'bottom-[-8px] left-1/2 -translate-x-1/2 border-t-gray-900'}
                ${position === 'bottom' && 'top-[-8px] left-1/2 -translate-x-1/2 border-b-gray-900'}
                ${position === 'left' && 'right-[-8px] top-1/2 -translate-y-1/2 border-l-gray-900'}
                ${position === 'right' && 'left-[-8px] top-1/2 -translate-y-1/2 border-r-gray-900'}
              `}
            />
          </div>
        )}
      </div>
    );
  }
);

Tooltip.displayName = 'Tooltip';

export interface TooltipTriggerProps extends HTMLAttributes<HTMLButtonElement> {
  'aria-describedby'?: string;
}

export function TooltipTrigger({ className = '', ...props }: TooltipTriggerProps) {
  return <button className={className} {...props} />;
}