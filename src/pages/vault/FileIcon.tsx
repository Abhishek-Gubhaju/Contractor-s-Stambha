import {
  File as FileBase,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  PenTool,
  Presentation,
} from 'lucide-react';
import type { VaultKind } from '../../types/vault';

export const KIND_LABELS: Record<VaultKind, string> = {
  pdf: 'PDF',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  image: 'Image',
  drawing: 'Drawing',
  archive: 'Archive',
  text: 'Text',
  other: 'Other',
};

/** Icon + palette per kind, shared by the list, the grid and the details pane. */
export const KIND_TONES: Record<VaultKind, string> = {
  pdf: 'text-rose-600 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300',
  word: 'text-blue-600 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-300',
  excel: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300',
  powerpoint: 'text-orange-600 bg-orange-50 dark:bg-orange-950/40 dark:text-orange-300',
  image: 'text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-300',
  drawing: 'text-cyan-700 bg-cyan-50 dark:bg-cyan-950/40 dark:text-cyan-300',
  archive: 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300',
  text: 'text-slate-600 bg-slate-100 dark:bg-slate-800 dark:text-slate-300',
  other: 'text-gray-600 bg-gray-100 dark:bg-gray-800 dark:text-gray-300',
};

const ICONS: Record<VaultKind, React.ComponentType<{ className?: string }>> = {
  pdf: FileText,
  word: FileText,
  excel: FileSpreadsheet,
  powerpoint: Presentation,
  image: FileImage,
  drawing: PenTool,
  archive: FileArchive,
  text: FileText,
  other: FileBase,
};

export function VaultFileIcon({
  kind,
  className = 'w-5 h-5',
}: {
  kind: VaultKind;
  className?: string;
}) {
  const Icon = ICONS[kind] || FileBase;
  return <Icon className={className} aria-hidden="true" />;
}
