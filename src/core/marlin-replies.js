// Parsing OctoPrint printer communication log lines (Send:/Recv:) and Marlin replies. Pure functions, no DOM or network.

const NUM = '(-?\\d+(?:\\.\\d+)?)';

/**
 * Regular expression of the server log filter (OctoPrint applies it as Python re.search to the whole line).
 * The syntax is common to Python and JavaScript. Passes:
 * - Send: only G0–G3, G28, G90–G92, M211, M503, M114, M118 (with or without a line number);
 * - Recv: coordinate lines (including "ok X:…"), the M211 reply (Soft endstops or "M211 S1 ; ON" + "Min: … Max: …"),
 *   M503 settings lines (M201, M203, M204, M205, M420 — with and without "echo:"; comments "echo:; …", M92, M851, G29 and the rest are not passed),
 *   PLT_ markers, "Unknown command".
 */
export const FEED_LOG_FILTER = '^(Send: (N[0-9]+ )?(G0?[0-3]|G28|G9[012]|M211|M503|M114|M118)( |\\*|$)'
  + '|Recv: ((ok )?X:|(echo:)?PLT_|.*Soft endstops|\\s*M211 S|\\s*Min:|(echo:)?\\s*M(20[1345]|420) |.*Unknown command))';

/** 'Send: N12 G0 X10*85' → { dir: 'send', text: 'N12 G0 X10*85' }; a foreign line form → null. */
export function parseLogLine(line) {
  const m = /^(Send|Recv): ?(.*)$/s.exec(String(line));
  return m ? { dir: m[1] === 'Send' ? 'send' : 'recv', text: m[2] } : null;
}

/** A command from the log without line number, checksum and comment, upper-cased, whitespace collapsed. */
export function normalizeSent(text) {
  return String(text)
    .replace(/;.*$/, '')
    .replace(/\*\d+\s*$/, '')
    .replace(/^\s*N\d+\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Command kind for coordinate tracking:
 * home (G28), setpos (G92), move (G0–G3, G91), mode (G90), query (M114, M211, M503, M118), other.
 */
export function classifySent(command) {
  const c = normalizeSent(command);
  const m = /^(G|M)0*(\d+)(?![0-9.])/.exec(c);
  if (!m) return 'other';
  const code = `${m[1]}${Number(m[2])}`;
  if (code === 'G28') return 'home';
  if (code === 'G92') return 'setpos';
  if (['G0', 'G1', 'G2', 'G3', 'G91'].includes(code)) return 'move';
  if (code === 'G90') return 'mode';
  if (['M114', 'M211', 'M503', 'M118'].includes(code)) return 'query';
  return 'other';
}

/**
 * Which coordinate parts (xy — sheet corner, z — touch) the command shifts: { xy, z } (both false — does not shift).
 * G28 without axes — both; with axes — only the named ones (X/Y → xy, Z → z); other parameters (O, R, L) do not count as axes.
 * G92: X/Y → xy, Z → z; only E (or other non-axis parameters) — neither; without parameters — both.
 * Other commands (including G0–G3) do not shift coordinates.
 */
export function epochParts(command) {
  const c = normalizeSent(command);
  const m = /^G0*(28|92)(?![0-9.])\s*(.*)$/.exec(c);
  if (!m) return { xy: false, z: false };
  const args = m[2];
  const letters = new Set(args.match(/[A-Z]/g) || []);
  const xy = letters.has('X') || letters.has('Y'), z = letters.has('Z');
  if (xy || z) return { xy, z };
  if (m[1] === '92' && letters.size) return { xy: false, z: false };
  return { xy: true, z: true };
}

/** Reply to M114: 'X:10.00 Y:20.00 Z:5.00 E:0.00 Count …' or 'ok X:… Y:… Z:…' → {x, y, z}; otherwise null. */
export function parsePosition(text) {
  const m = new RegExp(`(?:^|\\s)X:\\s*${NUM}\\s+Y:\\s*${NUM}\\s+Z:\\s*${NUM}`).exec(String(text));
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

/**
 * Reply to M211 → {enabled, min, max}; otherwise null. Marlin formats:
 * - one line: 'echo:Soft endstops: On   Min:  X0.00 Y0.00 Z0.00   Max:  X235.00 Y235.00 Z280.00';
 * - two lines (Neptune 3 Pro, Marlin 2.1): '  M211 S1 ; ON' and '  Min:  X-5.00 Y0.00 Z0.00   Max:  X235.00 Y232.00 Z283.00' —
 *   the lines are passed joined with a newline.
 */
export function parseLimits(text) {
  const s = String(text);
  const soft = /Soft endstops:?\s*(ON|OFF)/i.exec(s);
  const report = /M211\s+S([01])/i.exec(s);
  if (!soft && !report) return null;
  const enabled = soft ? soft[1].toUpperCase() === 'ON' : report[1] === '1';
  const axes = (name) => {
    const m = new RegExp(`${name}:\\s*X\\s*${NUM}\\s+Y\\s*${NUM}\\s+Z\\s*${NUM}`, 'i').exec(s);
    return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
  };
  const min = axes('Min'), max = axes('Max');
  return min && max ? { enabled, min, max } : null;
}

/**
 * Reply to M503 (several lines joined with a newline) → firmware settings; otherwise null.
 * Lines like 'echo:  M203 X300.00 Y300.00 Z5.00 E60.00' (and without 'echo:'), units mm/s and mm/s²:
 * M201 → maxAccel, M203 → maxFeed, M204 (P print, T travel) → accel, M205 (X Y Z, classic jerk) → jerk, M420 Z → meshFade.
 * Other lines (comments 'echo:; …', M92, M851, M206, G29 mesh) are ignored. A part absent from the reply
 * (or an axis without a number) is null; if there is no part at all — the whole result is null. M420 Z0 — fade is off (meshFade 0).
 * @returns {maxAccel: {x,y,z}|null, maxFeed: {x,y,z}|null, accel: {print, travel}|null, jerk: {x,y,z}|null, meshFade: number|null}|null
 */
export function parseFirmwareSettings(text) {
  const out = { maxAccel: null, maxFeed: null, accel: null, jerk: null, meshFade: null };
  const num = (args, letter) => {
    const m = new RegExp(`(?:^|\\s)${letter}\\s*${NUM}(?=\\s|$)`, 'i').exec(args);
    return m ? Number(m[1]) : null;
  };
  const xyz = (args) => {
    const v = { x: num(args, 'X'), y: num(args, 'Y'), z: num(args, 'Z') };
    return v.x !== null && v.y !== null && v.z !== null ? v : null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:echo:\s*)?M(201|203|204|205|420)(?:\s+(.*))?$/i.exec(raw.replace(/;.*$/, ''));
    if (!m) continue;
    const args = m[2] || '';
    if (m[1] === '201') out.maxAccel = xyz(args);
    else if (m[1] === '203') out.maxFeed = xyz(args);
    else if (m[1] === '205') out.jerk = xyz(args);
    else if (m[1] === '204') {
      const print = num(args, 'P'), travel = num(args, 'T');
      if (print !== null || travel !== null) out.accel = { print, travel };
    } else {
      const z = num(args, 'Z');
      if (z !== null) out.meshFade = z;
    }
  }
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Marker 'PLT_B 7' / 'echo:PLT_E 7' → { kind: 'B'|'E', rid }; otherwise null. */
export function parseMarker(text) {
  const m = /^\s*(?:echo:\s*)?PLT_([BE]) (\S+)\s*$/.exec(String(text));
  return m ? { kind: m[1], rid: m[2] } : null;
}

/** The line 'echo:Unknown command: "M118 PLT_B 7"' → the text of the unknown command; otherwise null. */
export function parseUnknownCommand(text) {
  const m = /Unknown command:\s*"?([^"]*)"?/i.exec(String(text));
  return m ? m[1].trim() : null;
}

/**
 * Are the profile limits (limX0…limY1) within the firmware limits? Disabled firmware limits are not checked.
 * @returns [{axis: 'X'|'Y', side: 'min'|'max', profile, firmware}] — violations; an empty array — all fine
 */
export function limitsWarnings(profile, firmware) {
  if (!firmware || !firmware.enabled) return [];
  const out = [];
  for (const axis of ['X', 'Y']) {
    const k = axis.toLowerCase();
    const lo = profile[`lim${axis}0`], hi = profile[`lim${axis}1`];
    if (Number.isFinite(lo) && lo < firmware.min[k] - 1e-6) out.push({ axis, side: 'min', profile: lo, firmware: firmware.min[k] });
    if (Number.isFinite(hi) && hi > firmware.max[k] + 1e-6) out.push({ axis, side: 'max', profile: hi, firmware: firmware.max[k] });
  }
  return out;
}

/** The warning text for the limitsWarnings violations, or ''. */
export function limitsWarningText(warnings) {
  if (!warnings.length) return '';
  const parts = warnings.map((w) => `${w.axis} ${w.side === 'min' ? 'мин' : 'макс'}: в профиле ${w.profile}, в прошивке ${w.firmware}`);
  return `Границы профиля выходят за границы прошивки (${parts.join('; ')}). Принтер остановит ход раньше.`;
}
