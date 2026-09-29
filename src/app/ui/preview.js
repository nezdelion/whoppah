// A preview on the field in printer coordinates (Y up): axis limits, sheet, drawing, travel moves.
import { allLines } from '../../core/drawing.js';

/** @param opts { machine: Drawing|null, field:{w,h}, corner:{x,y}, limits:{x0,x1,y0,y1}, showTravel, emptyText } */
export function renderPreview(canvas, { machine, field, corner, limits, showTravel, emptyText }) {
  const g = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const x0 = Math.min(limits.x0, corner.x) - 5, x1 = Math.max(limits.x1, corner.x + field.w) + 5;
  const y0 = Math.min(limits.y0, corner.y) - 5, y1 = Math.max(limits.y1, corner.y + field.h) + 5;
  const k = Math.min(W / (x1 - x0), H / (y1 - y0));
  const P = (x, y) => [(x - x0) * k, H - (y - y0) * k];
  const rect = (ax, ay, bx, by) => { const [px, py] = P(ax, by), [qx, qy] = P(bx, ay); return [px, py, qx - px, qy - py]; };

  g.setLineDash([6, 4]); g.strokeStyle = col('--limit'); g.lineWidth = 1;
  g.strokeRect(...rect(limits.x0, limits.y0, limits.x1, limits.y1));
  g.setLineDash([]);
  g.fillStyle = col('--paper'); g.strokeStyle = col('--field');
  g.fillRect(...rect(corner.x, corner.y, corner.x + field.w, corner.y + field.h));
  g.strokeRect(...rect(corner.x, corner.y, corner.x + field.w, corner.y + field.h));
  g.fillStyle = col('--muted'); g.font = '22px system-ui';
  const [cx, cy] = P(corner.x, corner.y);
  g.fillText(`угол X${corner.x} Y${corner.y}`, cx + 4, cy - 6);

  const lines = machine ? allLines(machine) : [];
  if (!lines.length) { g.fillText(emptyText, W / 2 - 80, H / 2); return; }
  if (showTravel) {
    g.strokeStyle = col('--travel'); g.lineWidth = 1; g.setLineDash([4, 4]); g.beginPath();
    let p = [corner.x, corner.y];
    for (const l of lines) { g.moveTo(...P(...p)); g.lineTo(...P(l[0], l[1])); p = [l[l.length - 2], l[l.length - 1]]; }
    g.stroke(); g.setLineDash([]);
  }
  g.strokeStyle = col('--ink'); g.lineWidth = 1.5; g.lineJoin = 'round'; g.beginPath();
  for (const l of lines) {
    g.moveTo(...P(l[0], l[1]));
    for (let i = 2; i < l.length; i += 2) g.lineTo(...P(l[i], l[i + 1]));
  }
  g.stroke();
}
