// Parsing OctoPrint printer communication log lines (Send:/Recv:) and Marlin replies. Pure functions, no DOM or network.

const NUM = '(-?\\d+(?:\\.\\d+)?)';

/**
 * Regular expression of the server log filter (OctoPrint applies it as Python re.search to the whole line).
 * The syntax is common to Python and JavaScript. Passes:
 * - Send: only G0–G3, G28, G90–G92, M211, M114, M118 (with or without a line number);
 * - Recv: coordinate lines (including "ok X:…"), the M211 reply (Soft endstops or "M211 S1 ; ON" + "Min: … Max: …"),
 *   PLT_ markers, "Unknown command".
 */
export const FEED_LOG_FILTER = '^(Send: (N[0-9]+ )?(G0?[0-3]|G28|G9[012]|M211|M114|M118)( |\\*|$)'
  + '|Recv: ((ok )?X:|(echo:)?PLT_|.*Soft endstops|\\s*M211 S|\\s*Min:|.*Unknown command))';

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
 * home (G28), setpos (G92), move (G0–G3, G91), mode (G90), query (M114, M211, M118), other.
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
  if (['M114', 'M211', 'M118'].includes(code)) return 'query';
  return 'other';
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
