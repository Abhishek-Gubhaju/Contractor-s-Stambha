// ============================================================================
// staffService — staff codes and staff file intake.
//
// Codes: a staff record may be entered without one; the next free code in the
// STF-001 series is derived from the records already on file (live and deleted),
// so an auto code never collides and never reuses a retired number.
//
// Files: a profile photo and the scanned documents (citizenship copy, letters,
// certificates) are read once into a data URL and stored on the staff record,
// which is project-scoped, backed up and mirrored — so they survive restarts.
// ============================================================================

export const STAFF_CODE_PREFIX = 'STF-';
/** A profile picture is small; 400 KB keeps the record lean. */
export const MAX_PHOTO_BYTES = 400 * 1024;
/** One scan per document; larger files belong in the backup folder instead. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;
/**
 * A staff record is stored whole, so a record that outgrows the local store
 * would be dropped silently by the browser. Refuse it with a clear message
 * instead — a document that did not persist is worse than one never attached.
 */
export const MAX_STAFF_RECORD_BYTES = 3 * 1024 * 1024;

/** Next free STF-### code, continuing from the highest number on file. */
export function nextStaffCode(records: { code?: string }[]): string {
  let max = 0;
  for (const record of records || []) {
    const match = String(record?.code || '').match(/(\d+)\s*$/);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${STAFF_CODE_PREFIX}${String(max + 1).padStart(3, '0')}`;
}

export interface ReadFileResult {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

/** Read a picked file into a data URL (offline: nothing leaves the machine). */
export function readFileAsDataUrl(file: File): Promise<ReadFileResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () =>
      resolve({
        dataUrl: String(reader.result || ''),
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        fileName: file.name,
      });
    reader.readAsDataURL(file);
  });
}

/** Human size for the document list ("412 KB", "1.2 MB"). */
export function formatBytes(bytes: number): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** `data:image/png;base64,…` → `image/png` (photo previews). */
export function mimeOfDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
  return match ? match[1] : '';
}
