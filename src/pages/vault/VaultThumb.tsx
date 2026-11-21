// Thumbnail for a vault document, shared by the File Vault page and the DSR
// editor. Reads the stored thumbnail once and caches it for the session; falls
// back to the type icon so a row never waits on an image.
import { useEffect, useState } from 'react';
import type { VaultDocument } from '../../types/vault';
import type { VaultContext } from '../../services/vault/storageTypes';
import type { VaultStorage } from '../../services/vault/storageTypes';
import { cn } from '../../utils';
import { KIND_TONES, VaultFileIcon } from './FileIcon';

const thumbCache = new Map<string, string>();

export function VaultThumb({
  doc,
  ctx,
  storage,
}: {
  doc: VaultDocument;
  ctx: VaultContext;
  storage: VaultStorage;
}) {
  const cacheKey = `${ctx.userId}/${ctx.projectId}/${doc.id}`;
  const [url, setUrl] = useState<string | null>(thumbCache.get(cacheKey) ?? null);

  useEffect(() => {
    if (url || !doc.thumb) return;
    let cancelled = false;
    storage
      .readBase64(ctx, { docId: doc.id, ext: 'jpg', variant: 'thumb' })
      .then((base64) => {
        if (cancelled || !base64) return;
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        thumbCache.set(cacheKey, dataUrl);
        setUrl(dataUrl);
      })
      .catch(() => {
        /* icon fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, ctx, doc.id, doc.thumb, storage, url]);

  if (url) {
    return <img src={url} alt="" className="w-9 h-9 rounded object-cover" />;
  }
  return (
    <span className={cn('w-9 h-9 rounded flex items-center justify-center shrink-0', KIND_TONES[doc.kind])}>
      <VaultFileIcon kind={doc.kind} className="w-4 h-4" />
    </span>
  );
}

export default VaultThumb;
