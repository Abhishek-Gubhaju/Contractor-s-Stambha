// Thumbnails for image files.
//
// A 12 MP phone photo makes a poor list row and a huge preview payload; the
// vault stores a 480 px JPEG beside the document instead. Any failure (no
// canvas, a broken image, an SVG) is non-fatal — the list falls back to the
// file-type icon.
export interface ThumbnailResult {
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 480;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // A decoder that never fires (locked file, unsupported codec) must not
    // leave the thumbnail promise pending forever.
    const timer = window.setTimeout(() => reject(new Error('That image took too long to read.')), 8000);
    const finish = (fn: () => void) => {
      window.clearTimeout(timer);
      fn();
    };
    image.onload = () => finish(() => resolve(image));
    image.onerror = () => finish(() => reject(new Error('That image could not be read.')));
    image.src = url;
  });
}

export async function makeThumbnail(file: File): Promise<ThumbnailResult | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.type === 'image/svg+xml') return null;
  if (file.size > MAX_SOURCE_BYTES) return null;
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (!dataUrl.startsWith('data:image/jpeg')) return null;
    return { dataUrl, width: targetWidth, height: targetHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
