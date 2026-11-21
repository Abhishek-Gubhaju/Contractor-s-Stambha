import { HTMLAttributes, forwardRef } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  className?: string;
  headerClassName?: string;
  width?: string;
}

export interface TableProps<T> extends HTMLAttributes<HTMLTableElement> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  isLoading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  striped?: boolean;
  hoverable?: boolean;
  bordered?: boolean;
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  isLoading = false,
  emptyMessage = 'No data available',
  onRowClick,
  striped = false,
  hoverable = true,
  bordered = true,
  className = '',
  ...props
}: TableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-sm ${className}`} {...props}>
        <thead className="bg-gray-50">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`
                  px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider
                  ${bordered ? 'border-b border-gray-200' : ''}
                  ${column.headerClassName || ''}
                `}
                style={{ width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {isLoading ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">
                <div className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-5 w-5 text-blue-600"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Loading...
                </div>
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, rowIndex) => (
              <tr
                key={keyExtractor(row)}
                className={`
                  ${striped && rowIndex % 2 === 1 ? 'bg-gray-50' : ''}
                  ${hoverable && onRowClick ? 'hover:bg-gray-50 cursor-pointer' : ''}
                  ${hoverable && !onRowClick ? 'hover:bg-gray-50' : ''}
                  transition-colors
                `}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`
                      px-4 py-3 text-gray-900
                      ${bordered ? 'border-b border-gray-100' : ''}
                      ${column.className || ''}
                    `}
                  >
                    {column.render ? column.render(row, rowIndex) : (row as any)[column.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  showPageNumbers?: boolean;
  maxPageNumbers?: number;
}

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  showPageNumbers = true,
  maxPageNumbers = 5,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = showPageNumbers ? getPageNumbers(currentPage, totalPages, maxPageNumbers) : [];

  return (
    <nav className="flex items-center justify-between px-4 py-3 border-t border-gray-100" aria-label="Pagination">
      <div className="text-sm text-gray-700">
        Page {currentPage} of {totalPages}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
          className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100"
          aria-label="First page"
        >
          ««
        </button>
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100"
          aria-label="Previous page"
        >
          «
        </button>
        {showPageNumbers && (
          <div className="flex items-center gap-1 mx-2">
            {pages.map((page, index) =>
              page === 'ellipsis' ? (
                <span key={`ellipsis-${index}`} className="px-2 text-gray-400">
                  ...
                </span>
              ) : (
                <button
                  key={page}
                  onClick={() => onPageChange(page as number)}
                  className={`
                    w-8 h-8 rounded-lg text-sm font-medium transition-colors
                    ${page === currentPage
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-700 hover:bg-gray-100'}
                  `}
                  aria-label={`Page ${page}`}
                  aria-current={page === currentPage ? 'page' : undefined}
                >
                  {page}
                </button>
              )
            )}
          </div>
        )}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100"
          aria-label="Next page"
        >
          »
        </button>
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
          className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg hover:bg-gray-100"
          aria-label="Last page"
        >
          »»
        </button>
      </div>
    </nav>
  );
}

function getPageNumbers(currentPage: number, totalPages: number, maxPages: number): (number | 'ellipsis')[] {
  if (totalPages <= maxPages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [];
  const halfMax = Math.floor(maxPages / 2);

  let start = Math.max(1, currentPage - halfMax);
  let end = Math.min(totalPages, start + maxPages - 1);

  if (end - start + 1 < maxPages) {
    start = Math.max(1, end - maxPages + 1);
  }

  if (start > 1) {
    pages.push(1);
    if (start > 2) pages.push('ellipsis');
  }

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (end < totalPages) {
    if (end < totalPages - 1) pages.push('ellipsis');
    pages.push(totalPages);
  }

  return pages;
}