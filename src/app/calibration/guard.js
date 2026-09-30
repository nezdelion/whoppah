// The "Not homed" guard: whether the pen may be installed now (capture, confirmation, jog panel), based on the feed state.
// No DOM. link — { state, detail, homed: {xy, z} } of the feed position source (standalone); null (plugin) — no guard.

export const HOME_HINT = 'Home не выполнен — сделайте Home до установки пера';

/**
 * What is allowed per coordinate part: xy — the sheet corner and X/Y moves, z — the touch and Z moves.
 * Feed not connected — both forbidden with a reason; connected — a part is allowed only if the feed has seen its homing.
 * @returns {{ xy: {ok: boolean, message: string}, z: {ok: boolean, message: string} }}
 */
export function guardState(link) {
  const allow = { ok: true, message: '' };
  if (!link) return { xy: allow, z: allow };
  if (link.state !== 'live') {
    const no = { ok: false, message: `Поток связи с принтером не на связи${link.detail ? `: ${link.detail}` : ''}` };
    return { xy: no, z: no };
  }
  const home = { ok: false, message: HOME_HINT };
  return { xy: link.homed.xy ? allow : home, z: link.homed.z ? allow : home, homeMissing: !link.homed.xy || !link.homed.z };
}

/** A single hint for the panel: the first non-empty denial message (both parts wait for Home — one phrase). */
export function guardHint(g) {
  return g.xy.message || g.z.message;
}

/** A function `(part) => {ok, message}` for the capture and jog services; without a feed source — always allowed. */
export function createGuard(positionSource) {
  return (part) => guardState(positionSource && positionSource.link ? positionSource.link() : null)[part];
}
