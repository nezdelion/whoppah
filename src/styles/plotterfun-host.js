// Classic wrapper worker for one plotterfun style (the style sources are not edited).
// Messages to the worker: {type:'init', style, model, base}, then {type:'run', runId, image, params}
// and {type:'params', runId, params} for live parameters. From the worker: {type:'sliders'|'msg'|'svg-path'|'final'|'error', ...}.
// The execution model (design.md 3a) decides when 'final' is sent:
//   sync          — right after the handler returns
//   async-handler — when the Promise returned by the handler completes
//   timer-chain   — the handler returned, there are no tracked timers, and a separate macrotask confirmed it
//   none          — never
// The file runs both as a worker and (in tests) in a vm context with the same globals.
(function (g) {
  const realPost = g.postMessage.bind(g);
  const realSetTimeout = g.setTimeout.bind(g);
  const realClearTimeout = g.clearTimeout.bind(g);
  const realSetInterval = g.setInterval.bind(g);
  const realClearInterval = g.clearInterval.bind(g);
  const realImport = g.importScripts.bind(g);

  let model = 'none', base = '', styleHandler = null, config = null, pixData = null;
  let runId = 0, running = false, handlerDone = false, finalSent = false;
  const timers = new Set(); // active tracked timers and intervals

  const send = (msg) => realPost(Object.assign({ runId }, msg));
  const fail = (e) => send({ type: 'error', message: e && e.message ? e.message : String(e) });

  function declareFinal() {
    if (running && !finalSent) { finalSent = true; running = false; send({ type: 'final' }); }
  }

  // Only for timer-chain: by the time of the macrotask all continuation microtasks have already run.
  function check() {
    if (model === 'timer-chain' && running && handlerDone && timers.size === 0) declareFinal();
  }
  const scheduleCheck = () => { realSetTimeout(check, 0); };

  // --- timer substitution: the wrappers transparently call the originals and only count
  g.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== 'function') return realSetTimeout(fn, ms, ...args);
    let id;
    id = realSetTimeout(function () {
      timers.delete(id);
      try { fn.apply(this, args); } catch (e) { fail(e); }
      scheduleCheck();
    }, ms);
    timers.add(id);
    return id;
  };
  g.clearTimeout = function (id) { timers.delete(id); return realClearTimeout(id); };
  g.setInterval = function (fn, ms, ...args) {
    if (typeof fn !== 'function') return realSetInterval(fn, ms, ...args);
    const id = realSetInterval(function () {
      try { fn.apply(this, args); } catch (e) { fail(e); }
      scheduleCheck();
    }, ms);
    timers.add(id);
    return id;
  };
  g.clearInterval = function (id) { timers.delete(id); return realClearInterval(id); };

  // --- postMessage substitution: plotterfun messages ['sliders'|'msg'|'svg-path'|'dbg', data]
  g.postMessage = function (msg) {
    if (!Array.isArray(msg)) return realPost(msg);
    const [kind, data] = msg;
    if (kind === 'sliders') send({ type: 'sliders', controls: data });
    else if (kind === 'msg') send({ type: 'msg', text: String(data) });
    else if (kind === 'svg-path') send({ type: 'svg-path', d: data, late: finalSent });
    return undefined;
  };

  function deliver(args) {
    running = true; finalSent = false; handlerDone = false;
    let result;
    try { result = styleHandler({ data: args }); } catch (e) { running = false; fail(e); return; }
    const done = () => {
      handlerDone = true;
      if (model === 'sync' || model === 'async-handler') declareFinal();
      else if (model === 'timer-chain') scheduleCheck();
    };
    if (model === 'sync') { done(); return; }
    Promise.resolve(result).then(done, (e) => { running = false; fail(e); });
  }

  function onInit(msg) {
    model = msg.model || 'none';
    base = msg.base;
    g.importScripts = function (...names) { realImport(...names.map((n) => base + n)); };
    try {
      realImport(base + msg.style + '.js');
    } catch (e) { fail(e); return; }
    styleHandler = g.onmessage;
    g.onmessage = onMessage;
  }

  function onMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'init') { onInit(msg); return; }
    if (!styleHandler) return;
    runId = msg.runId;
    if (msg.type === 'run') {
      const { width, height, data } = msg.image;
      config = Object.assign({}, msg.params, { width, height });
      pixData = typeof g.ImageData === 'function' ? new g.ImageData(data, width, height) : { data, width, height };
      deliver([config, pixData]);
    } else if (msg.type === 'params') {
      if (!config) return;
      Object.assign(config, msg.params);
      deliver([config]); // as in plotterfun main.htm: the full config
    }
  }

  g.onmessage = onMessage;
})(typeof self !== 'undefined' ? self : globalThis);
