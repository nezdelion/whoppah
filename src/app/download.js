export function downloadText(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** File name from the source name: without extension and forbidden characters. */
export function baseName(name, fallback = 'plot') {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return base || fallback;
}
