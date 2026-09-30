// Firmware settings (M503) read through the connection feed are kept in memory only (not written to storage or the settings file)
// and, like the M211 limits, are bound to the feed session: a drop, reconnect, or address/key change erases them — read again.
// The result is used in the print time estimate (print-tab) and in warnings (feed-indicator).
// No DOM: the logic is separate from the UI so it can be tested.
export function createFirmwareMemo(feed) {
  let value = null, session = -1;
  const listeners = new Set();
  const emit = () => { for (const l of [...listeners]) l(); };
  const valid = () => feed.state() === 'live' && feed.session() === session;
  // a stale result is erased immediately when the feed state changes, subscribers are notified
  feed.onChange(() => { if (value && !valid()) { value = null; emit(); } });
  return {
    /** The current result, or null if there is none or it is stale. */
    get() { if (value && !valid()) value = null; return value; },
    /** Reads the settings; if the session changed during the read, the result is discarded (null). */
    async read() {
      const had = !!value;
      value = null;
      if (had) emit();
      const s = feed.session();
      const v = await feed.readFirmwareSettings();
      if (feed.state() !== 'live' || feed.session() !== s) return null;
      session = s; value = v;
      emit();
      return v;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
