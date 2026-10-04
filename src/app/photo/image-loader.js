// Photo loading: EXIF-aware decoding, white background under transparency, scaling to the working resolution -> ImageData.
import { t } from '../../i18n/index.js';

export class ImageLoadError extends Error {
  constructor(message = t('photo.err.openImage')) {
    super(message);
    this.name = 'ImageLoadError';
  }
}

export const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

/** Size by the long side longSide preserving proportions (at least 1 px). */
export function fitSize(width, height, longSide) {
  const k = longSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** @returns {{name, width, height, bitmap}} the EXIF orientation is already applied by the browser */
export async function decodeImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { name: file.name || '', width: bitmap.width, height: bitmap.height, bitmap };
  } catch (e) {
    throw new ImageLoadError();
  }
}

/**
 * White background + scaling -> ImageData with the long side longSide. rect { x, y, w, h } (source px, optional) — the crop
 * frame: only that part of the image is drawn, and it gets the whole working resolution.
 */
export function rasterize(decoded, longSide, rect = null) {
  const src = rect || { x: 0, y: 0, w: decoded.width, h: decoded.height };
  const { width, height } = fitSize(src.w, src.h, longSide);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(decoded.bitmap, src.x, src.y, src.w, src.h, 0, 0, width, height);
  return g.getImageData(0, 0, width, height);
}
