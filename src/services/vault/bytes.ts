// Small, dependency-free byte helpers for the vault.
//
// File data crosses the bridge as base64 (Tauri's JSON IPC has no binary frame
// in the versions this app supports). The chunked uploader keeps each slice at
// 4 MiB, so `String.fromCharCode(...bytes)` never sees an argument list large
// enough to blow the stack.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64ToBlob(value: string, mime: string): Blob {
  const bytes = base64ToBytes(value);
  return new Blob([bytes.buffer as ArrayBuffer], { type: mime || 'application/octet-stream' });
}

export function base64ToText(value: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(value));
  } catch {
    return '';
  }
}

/** Decoded byte length of base64 (no data-URL prefix). */
export function base64Bytes(value: string): number {
  const text = String(value || '');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

/** `data:image/png;base64,AAAA` → `AAAA` (null when it is not a data URL). */
export function dataUrlBody(dataUrl: string): string | null {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) return null;
  if (!/^data:/i.test(dataUrl)) return null;
  return String(dataUrl).slice(comma + 1);
}
