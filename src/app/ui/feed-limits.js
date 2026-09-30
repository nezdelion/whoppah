// Firmware limits (M211) read through the connection feed are bound to the feed session: valid while the feed is connected
// in the same session (feed.session()). A drop, reconnect, or address/key change resets the result and the warnings
// about the profile — read again (we erase rather than mark "stale": old numbers next to a new "connected" are misleading).
// No DOM: the logic is separate from the indicator so it can be tested.
export function createLimitsMemo(feed) {
  let limits = null, session = -1;
  const valid = () => feed.state() === 'live' && feed.session() === session;
  return {
    /** The current result, or null if it is stale. */
    get() { if (limits && !valid()) limits = null; return limits; },
    /** Reads the limits; if the session changed during the read, the result is discarded (null). */
    async read() {
      limits = null;
      const s = feed.session();
      const l = await feed.readLimits();
      if (feed.state() !== 'live' || feed.session() !== s) return null;
      session = s; limits = l;
      return l;
    },
  };
}
