import { LayoutGrid, List, Search, Trash2, X } from 'lucide-react';
import type { VaultKind, VaultSort } from '../../types/vault';
import { KIND_LABELS } from './FileIcon';
import { cn } from '../../utils';

const KINDS: Array<VaultKind | 'all'> = [
  'all', 'pdf', 'word', 'excel', 'powerpoint', 'image', 'drawing', 'archive', 'text', 'other',
];

interface Props {
  query: string;
  onQuery: (value: string) => void;
  kind: VaultKind | 'all';
  onKind: (value: VaultKind | 'all') => void;
  tag: string | null;
  tags: string[];
  onTag: (value: string | null) => void;
  sort: VaultSort;
  onSort: (value: VaultSort) => void;
  view: 'list' | 'grid';
  onView: (value: 'list' | 'grid') => void;
  showTrash: boolean;
  trashCount: number;
  onToggleTrash: () => void;
  onClear: () => void;
  hasFilters: boolean;
}

export function VaultToolbar({
  query,
  onQuery,
  kind,
  onKind,
  tag,
  tags,
  onTag,
  sort,
  onSort,
  view,
  onView,
  showTrash,
  trashCount,
  onToggleTrash,
  onClear,
  hasFilters,
}: Props) {
  return (
    <div className="space-y-3" data-testid="vault-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search name, tag or note…"
            aria-label="Search files"
            data-testid="vault-search"
            className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <select
          value={tag ?? ''}
          onChange={(event) => onTag(event.target.value || null)}
          aria-label="Filter by tag"
          data-testid="vault-tag-filter"
          className="text-sm rounded-lg border border-gray-300 bg-white px-2 py-2 text-gray-700 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200"
        >
          <option value="">All tags</option>
          {tags.map((row) => (
            <option key={row} value={row}>
              #{row}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(event) => onSort(event.target.value as VaultSort)}
          aria-label="Sort files"
          data-testid="vault-sort"
          className="text-sm rounded-lg border border-gray-300 bg-white px-2 py-2 text-gray-700 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200"
        >
          <option value="updated">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="size">Largest first</option>
          <option value="kind">Type</option>
        </select>

        <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden">
          <button
            type="button"
            onClick={() => onView('list')}
            aria-label="List view"
            aria-pressed={view === 'list'}
            className={cn(
              'p-2',
              view === 'list'
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800'
            )}
          >
            <List className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onView('grid')}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className={cn(
              'p-2 border-l border-gray-300 dark:border-gray-700',
              view === 'grid'
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800'
            )}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleTrash}
          aria-pressed={showTrash}
          data-testid="vault-trash-toggle"
          className={cn(
            'inline-flex items-center gap-1.5 text-sm rounded-lg border px-2.5 py-2',
            showTrash
              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
          )}
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" />
          Trash
          {trashCount > 0 && (
            <span className="text-[11px] rounded-full bg-rose-600 text-white px-1.5 py-0.5 leading-none">
              {trashCount}
            </span>
          )}
        </button>

        {hasFilters && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-gray-500 hover:text-gray-800 underline underline-offset-2 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by file type">
        {KINDS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onKind(value)}
            aria-pressed={kind === value}
            data-testid={`vault-kind-${value}`}
            className={cn(
              'text-xs rounded-full border px-2.5 py-1 transition-colors',
              kind === value
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            )}
          >
            {value === 'all' ? 'All types' : KIND_LABELS[value]}
          </button>
        ))}
      </div>
    </div>
  );
}
