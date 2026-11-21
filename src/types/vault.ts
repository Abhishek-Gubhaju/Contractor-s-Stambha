// ============================================================================
// File Vault — the shape of the job's document container.
//
// Only METADATA lives here (and therefore in localStorage, the native mirror
// and the backup). The file itself is a real file on disk (desktop) or an
// IndexedDB blob (browser): a 40 MB AutoCAD drawing can never sit inside the
// ~5 MB localStorage quota, and base64 would inflate it by another third.
// ============================================================================

/** What a stored file is, for the icon, the filter chips and the preview. */
export type VaultKind =
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'image'
  | 'drawing'
  | 'archive'
  | 'text'
  | 'other';

/** A folder the app manages itself, rather than the person filing files. */
export type VaultFolderSystem = 'dsr' | 'dsr-month' | 'dsr-date';

/** A folder in the vault tree. `parentId === null` means the top level. */
export interface VaultFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Set for the folders Daily Site Reports keeps its files in. Identity is this
   * flag, not the name: renaming the folder must never orphan the next upload.
   */
  system?: VaultFolderSystem;
  /**
   * The stable key inside a managed tree (a month or a date). The name may be
   * renamed; the key is what the next upload resolves against.
   */
  systemKey?: string;
}

/** Dimensions of the stored thumbnail, when one could be made. */
export interface VaultThumb {
  width: number;
  height: number;
}

/**
 * One stored file. `folderId === null` is the "Unsorted" root.
 *
 * `checksum` is the 16-hex FNV-1a fingerprint the native layer computed while
 * writing the bytes — used for duplicate detection, restore merging and the
 * honest "this file is missing/damaged" state.
 */
export interface VaultDocument {
  id: string;
  folderId: string | null;
  /** Display name as the person picked it, with path separators stripped. */
  name: string;
  /** Lower-case extension without the dot (`pdf`, `dwg`, or `bin`). */
  ext: string;
  mime: string;
  kind: VaultKind;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  notes: string;
  thumb: VaultThumb | null;
  /** Set when the file sits in Trash; absent for live files. */
  deletedAt?: string;
  /** Where a trashed file came from, so Restore puts it back. */
  deletedFromFolderId?: string | null;
}

/** Where the bytes actually are. */
export type VaultMode = 'desktop' | 'browser' | 'memory';

/** Sorting choices offered by the toolbar. */
export type VaultSort = 'updated' | 'name' | 'size' | 'kind';

export interface VaultQuery {
  /** Free text across name, tags, notes and folder name. */
  query?: string;
  kind?: VaultKind | 'all';
  /** `undefined` = every folder, `null` = the root, a string = that folder. */
  folderId?: string | null;
  tag?: string | null;
  /** Include items sitting in Trash. */
  includeTrash?: boolean;
  sort?: VaultSort;
  page?: number;
}
