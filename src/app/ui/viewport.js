// View (zoom and pan) for the preview: wheel — zoom around the cursor, drag — pan, double-click — "fit".
// Coordinates are in canvas backing-buffer units (not CSS). zoom = 1 — "fit"; the content always covers the field.

export function createViewport({ minZoom = 1, maxZoom = 20 } = {}) {
  const v = { zoom: 1, ox: 0, oy: 0, w: 1, h: 1, minZoom, maxZoom };

  function clamp() {
    v.zoom = Math.min(v.maxZoom, Math.max(v.minZoom, v.zoom));
    v.ox = Math.min(0, Math.max(v.w - v.w * v.zoom, v.ox));
    v.oy = Math.min(0, Math.max(v.h - v.h * v.zoom, v.oy));
  }

  /** The field size changed: keep the same visible part of the content. */
  v.setSize = (w, h) => {
    if (!(w > 0 && h > 0)) return;
    if (w !== v.w || h !== v.h) { v.ox *= w / v.w; v.oy *= h / v.h; v.w = w; v.h = h; clamp(); }
  };
  v.reset = () => { v.zoom = 1; v.ox = 0; v.oy = 0; };
  v.isFit = () => v.zoom === 1 && v.ox === 0 && v.oy === 0;
  /** Zoom at the screen point (x,y) so that the point under the cursor stays in place. */
  v.zoomAt = (x, y, factor) => {
    const z = Math.min(v.maxZoom, Math.max(v.minZoom, v.zoom * factor));
    const r = z / v.zoom;
    v.ox = x - (x - v.ox) * r; v.oy = y - (y - v.oy) * r; v.zoom = z;
    clamp();
  };
  v.panBy = (dx, dy) => { v.ox += dx; v.oy += dy; clamp(); };
  v.toScreen = (x, y) => [x * v.zoom + v.ox, y * v.zoom + v.oy];
  v.toContent = (x, y) => [(x - v.ox) / v.zoom, (y - v.oy) / v.zoom];
  /** Canvas transform: further we draw in "fit" coordinates; divide the line thickness by v.zoom. */
  v.apply = (g) => g.setTransform(v.zoom, 0, 0, v.zoom, v.ox, v.oy);

  /** Subscribes to canvas events; onChange() is called after every view change. Returns an unsubscribe function. */
  v.attach = (canvas, onChange) => {
    const pts = new Map();
    let pinch = null;
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      const k = r.width ? canvas.width / r.width : 1;
      return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k];
    };
    const changed = () => { canvas.style.touchAction = v.zoom > 1 ? 'none' : 'pan-y'; onChange(); };
    const size = () => v.setSize(canvas.width, canvas.height);
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 }; };

    const on = {
      wheel(e) {
        e.preventDefault();
        size();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const [x, y] = at(e);
        v.zoomAt(x, y, Math.exp(-e.deltaY * unit * 0.0015));
        changed();
      },
      pointerdown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        size();
        pts.set(e.pointerId, at(e));
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
        if (pts.size === 2) pinch = mid();
      },
      pointermove(e) {
        const prev = pts.get(e.pointerId);
        if (!prev) return;
        const cur = at(e);
        pts.set(e.pointerId, cur);
        if (pts.size === 1) {
          if (v.zoom > 1 || e.pointerType === 'mouse') { v.panBy(cur[0] - prev[0], cur[1] - prev[1]); changed(); }
        } else if (pts.size === 2 && pinch) {
          const m = mid();
          v.panBy(m.x - pinch.x, m.y - pinch.y);
          v.zoomAt(m.x, m.y, m.d / pinch.d);
          pinch = m; changed();
        }
        if (v.zoom > 1 && e.cancelable) e.preventDefault();
      },
      pointerup(e) { pts.delete(e.pointerId); pinch = pts.size === 2 ? mid() : null; },
      pointercancel(e) { pts.delete(e.pointerId); pinch = null; },
      dblclick() { v.reset(); changed(); },
      keydown(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        size();
        const cx = canvas.width / 2, cy = canvas.height / 2;
        if (e.key === '+' || e.key === '=') v.zoomAt(cx, cy, 1.25);
        else if (e.key === '-' || e.key === '_') v.zoomAt(cx, cy, 0.8);
        else if (e.key === '0') v.reset();
        else return;
        e.preventDefault(); changed();
      },
    };
    for (const [n, f] of Object.entries(on)) canvas.addEventListener(n, f, n === 'wheel' ? { passive: false } : undefined);
    canvas.style.touchAction = v.zoom > 1 ? 'none' : 'pan-y'; // a view kept across a remount may already be zoomed
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    return () => { for (const [n, f] of Object.entries(on)) canvas.removeEventListener(n, f); };
  };
  return v;
}
