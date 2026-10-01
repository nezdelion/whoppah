# Neptune Plotter

[Русская версия](README.ru.md)

Web app for a pen plotter on an Elegoo Neptune 3 Pro (Marlin) controlled by OctoPrint 1.11:
drawing (currently SVG) → layout on the sheet → pen G-code → download or send to OctoPrint.

Plain JavaScript (ES modules), no build step and no npm dependencies.

## Running

```sh
cd plotter
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Does not work from `file://` (ES modules), an http server is required. Recent Firefox and Chromium.

## OctoPrint setup

1. In OctoPrint: Settings → API → enable **Enable Cross Origin Resource Sharing (CORS)**.
2. Get the **API key** there too (Settings → API → Application Keys or the global key).
3. In the app, "Print" tab → "Connection": the address (`http://localhost:5000` for OctoPrint on the same machine, default; `http://octopi.local` for OctoPi on a Raspberry Pi) and the key; the "Test connection" button.

Without an address and key the send buttons are inactive; G-code download works. The key is stored only in the browser's localStorage and is not included in the settings export file.

## Interface language

Languages: English (`en`, fallback) and Russian (`ru`). Dictionaries are flat modules `src/i18n/en.js` and `ru.js` with stable dotted keys (`print.upload`); a value is a string with `{params}` or plural forms `{ one, few, many, other }` (chosen by `Intl.PluralRules` from the `count` parameter). `t(key, params)`: if the key is missing in the current language, English is used; if missing there too, the key itself. Numbers in text are formatted by `fmtNumber` (`Intl.NumberFormat`: "1.5" / "1,5"); in G-code and input fields always a dot. `tests/i18n.test.js` checks that the key sets and `{name}` parameters in `en` and `ru` match, that all `t('…')` from `src` are in the dictionary, and that no Cyrillic remains in `src` outside the dictionary.

Which language to enable (`src/i18n/detect.js`, `src/app/lang.js`), in descending priority:

1. an explicit choice in settings ("Language": Auto / English / Russian), stored in `localStorage` (`neptune-plotter.lang`);
2. plugin: the interface language of the current OctoPrint user — `language` in the dynamic `env.json` (user setting `interface.language`, otherwise the global `appearance.defaultLanguage`; "_default" means "not chosen");
3. `navigator.languages`: the first supported one (`ru*` → Russian, `en*` → English);
4. otherwise English (including for an unsupported OctoPrint language, e.g. `de`, in which case the browser language is checked).

The language is chosen once at startup, before the UI is built; changing it in settings saves the choice and **reloads the page** (simpler and more reliable than rebuilding live tabs). Texts that appear in schemas, constants and the registry are computed on access (getters), so they do not get "frozen" in the language at module load. The plugin server (Python) texts stay English: the app shows them only as error details.

**New string**: add the key to both dictionaries (in `en.js` and `ru.js`, same parameters), in code — `t('key', { param })`. Tests that check Russian texts import `tests/helpers/ru.js` (pins `ru`).

## Settings

Three sections with different change frequency:

- **Calibration**: the paper corner (nozzle X/Y coordinates when the pen is at the left near corner of the sheet) and the paper touch Z. Changes with every sheet or pen; stored with a date.
- **Machine profile**: pen heights as offsets from the touch, feeds, axis limits, pen width, `G28`/`M84`.
- **Job**: paper format (custom formats are saved), orientation, margin, alignment, rotation, "as is in mm", simplification (RDP) and merge tolerances.

Settings export/import via a file is at the bottom of the settings panel. Settings of the old page (`neptune-plotter.settings`) are migrated once on first launch.

## OctoPrint plugin

The app can be served by OctoPrint 1.11 itself as a full-screen page at `/plugin/plotter/`: no separate server, API key or CORS, with settings shared across all devices. Standalone mode (above) keeps working in parallel.

**Modes.** On startup the app reads `env.json` next to the page: static `{"mode":"standalone"}` — REST with an API key and settings in the browser; the plugin's dynamic `env.json` — OctoPrint session auth (`X-CSRF-Token` header) and settings on the server. The tab and core code does not depend on the mode; in plugin mode the address and key are not shown, and the header has an "← OctoPrint" link.

**Installation.**

```sh
python3 tools/build_plugin.py        # copies index.html, src/, vendor/ into the plugin package and builds dist/OctoPrint-Plotter-<version>.zip
```

OctoPrint → Settings → Plugin Manager → "Get More…" → "… from an uploaded file" → choose the zip → restart OctoPrint. A "Plotter" link appears in the top bar. Update the same way with a new zip (after the restart the browser re-validates the files itself: the page and static files are served with `Cache-Control: no-cache` and ETag). Uninstall in Plugin Manager. The version is in `octoprint-plugin/octoprint_plotter/_version.py` (or `--version X.Y.Z` at build time).

**Permissions and settings storage.**

- The page and service URLs are available only to logged-in users (without login — redirect to the OctoPrint login and back to the app).
- The machine profile and calibration are shared by everyone; job parameters and presets are per user.
- Writing the profile requires the **"Plotter: Machine profile"** permission (`PLUGIN_PLOTTER_MACHINE_PROFILE`): the administrators group has it by default; it is granted in Settings → Access Control (to a user or group). Without the permission the profile is shown read-only.
- Writing the calibration requires the standard OctoPrint **Control** permission. Print, upload and pause are checked against OctoPrint permissions (Print, File Upload, Control); on denial "permission required: …" is shown.
- A section is at most 1 MB; unknown sections are rejected by the server.

**Calibration capture and jog panel.** Bring the pen over with the standard Control tab, then on the "Print" tab press "Corner here" (accounting for the pen offset from the sheet corner) or "Touch here"; the position is read with `M118`/`M400`/`M114` (unavailable while printing). "Corner is correct" / "Touch is correct" confirm a part without changing values. After homing (`G28`) or a printer reconnect the app shows "calibration may be outdated", and printing requires confirmation. Requires the Control permission and firmware that answers `M118`.

The same buttons exist in standalone when the printer feed is connected: the calibration lives in the browser and the coordinate epochs in the feed memory, so after a page reload both parts are considered outdated until a new capture or "Corner is correct" / "Touch is correct". Until the feed has seen `G28` (since connecting to the printer; Home is tracked separately for XY and Z), capture and the jog panel are disabled with the hint "Not homed — home before installing the pen"; the app never sends `G28` itself; if Home was done before the page was opened (`G28` is dangerous with a pen), the "Already homed" button with confirmation removes the guard until the next reconnect, and does not change the coordinate epochs. The jog panel (X±/Y±/Z±, step 0.1/1/10 mm, both modes) reads the position before each step, does not go beyond the profile axis limits, and Z not more than 2 mm below the touch.

**Firmware settings (standalone, feed connected).** "Read firmware settings" ("Connection" section) sends `M503` and parses `M201`/`M203`/`M204`/`M205`/`M420`: a summary, warnings (profile feeds above `M203`, mesh fade below the touch), "Fill in profile accelerations…" on confirmation. The result is kept only in memory, until the feed drops; while it exists, the time estimate clamps feeds by `M203` and starts from the `M205` jerk (marked "accounting for firmware"). The plugin has no feed — not available there.

**Transferring settings from standalone.** In standalone: "Export to file" at the bottom of the settings panel; in the plugin: "Import from file…". The profile and calibration are skipped with a message if permissions are missing, the rest is imported. If the user has no settings on the server yet, but `localStorage` of the same address (host:port) has standalone settings, the app offers to transfer them itself.

**Development.**

```sh
tools/dev_octoprint.sh               # .venv + OctoPrint 1.11 + plugin (editable) + Virtual Printer, port 5001, data in .octoprint-dev
tools/test_plugin.sh                 # plugin tests: shared .venv (created once), also works from a git worktree
```

On first launch finish the setup wizard in the browser (first user). The app is copied into the plugin on every script run; after editing `src/` rerun the script (or `python3 tools/build_plugin.py --no-zip`). Behind a reverse proxy with a prefix (`X-Script-Name`) the URLs are built from `script_root`, and the app opens at `https://host/octoprint/plugin/plotter/`.

## Structure and dependency rule

```
index.html                entry point
src/core/                 pure functions over Drawing: geometry, svg-import, svg-export, optimize, layout, gcode, profile, pipeline
src/transport/            Transport interface, OctoPrint REST (fetch), auth by key and by session (plugin)
src/storage/              SettingsStore (localStorage, OctoPrint server), settings file
src/i18n/                 localization: t(key, params), dictionaries en.js / ru.js, language choice (detect.js); imports nothing
src/styles/               "image → lines" styles: registry, runner (workers), plotterfun adapter, own styles (own/)
vendor/plotterfun/        third-party plotterfun code (unmodified copy), version in vendor/plotterfun/UPSTREAM
octoprint-plugin/         OctoPrint Python plugin (page, env.json, settings API, permission)
tools/                    build_plugin.py (zip build), dev_octoprint.sh (local OctoPrint)
src/app/                  shell: state, tabs, forms, preview, print service
tests/                    node --test
```

`i18n` → nothing (and does not touch the DOM); `core`, `transport`, `storage`, `styles`, `app` may import `i18n` (core returns ready-made error and warning texts); `core` → only `core` and `i18n`; `transport`, `storage` — likewise only their own layer and `i18n`; `styles` → `core` (`styles/tone.js` and `styles/own/*` — only `core`, no DOM); `app` → everything. The rule is checked by `tests/deps.test.js`.
All modules exchange the `Drawing` model (layers of polylines, flat arrays `[x0, y0, x1, y1, ...]`, "document" or "machine" coordinate system).

Processing order (`core/pipeline.js`): import → layout (mm) → simplification → sorting/merging → G-code.

## Tests

```sh
npm test        # or: node --test
```

plotterfun style wrapper (`tests/plotterfun-host.test.js`): by default a fast set (one style per execution model, the "style fails by itself" case, data after final), the whole `node --test` takes about 7 s. Full sweep of 23 styles over parameter variants and two images (about 2 minutes): `PLOTTERFUN_SWEEP=1 node --test tests/plotterfun-host.test.js`; `PLOTTERFUN_FULL=1` additionally sets a 1 s quiet period after final and 5 s for the reference.

Plugin tests: `tools/test_plugin.sh` (arguments go to pytest). The `.venv` in the main checkout is created on first run (OctoPrint 1.11 + pytest) and reused afterwards, including from a worktree; `tools/dev_octoprint.sh` uses the same venv.

Golden G-code for parity with the old implementation: `tests/fixtures/*.gcode`; regenerated by `node tests/tools/gen-golden.js` (uses a copy of the old core `tests/tools/legacy-core.cjs`).

## How to add a drawing source

Create `src/app/tabs/<name>-tab.js`, export a factory of the object `{ id, title, mount(el, ctx), unmount() }` and add it to the tab list in `src/app/main.js`. A source receives only `ctx`:

- `ctx.emit(drawing)` — emit a drawing (`createDrawing` from `core/drawing.js`, "document" coordinates);
- `ctx.presets.load()/save(obj)` — its own storage area;
- `ctx.printParams.get()/subscribe(fn)` — read-only: field, margin, rotation, pen width.

The "Print" tab does not change. An intermediate result is marked `meta.partial = { reasons: [...] }`.

### "Photo" tab and styles

The "Photo" tab (`src/app/tabs/photo-tab.js`) is an ordinary source: image → stack of style layers → `ctx.emit(drawing)`, each visible layer becomes a drawing layer. Computation runs in workers (`src/styles/runner.js`), a new run of a layer cancels the previous one. A layer gets the "done" status only on a reliable completion signal; for plotterfun styles it is built by the wrapper `src/styles/plotterfun-host.js` from the manifest `src/styles/plotterfun-completion.json` (execution model of each style: `sync`, `async-handler`, `timer-chain`, `none`). The manifest applies only to the commit from the first line of `vendor/plotterfun/UPSTREAM`; after updating vendor run `python3 tools/audit_plotterfun.py` — unverified styles get `none` (the result stays intermediate, printing needs confirmation).

Adding your own style: a pure function `(gray, w, h, params) => lines` in `src/styles/own/`, an entry in `src/styles/own/worker.js` (the `IMPL` table) and a descriptor in `src/styles/registry.js`.

## Third-party code

- **plotterfun** — Tim Alex Jacobs (mitxela), MIT license, <https://github.com/mitxela/plotterfun>. The style files and `helpers.js` are in `vendor/plotterfun/` unmodified together with `LICENSE`; the upstream commit is in `vendor/plotterfun/UPSTREAM`. Update = replace the directory + `tools/audit_plotterfun.py` + recheck the styles with asynchronous code.
- `vendor/plotterfun/external/` holds `rhill-voronoi-core.min.js` (Raymond Hill, MIT, <https://github.com/gorhill/Javascript-Voronoi>) and `stackblur.min.js` (StackBlur, <https://github.com/flozz/StackBlur>), as in upstream; their copyright stays in the file headers.

## How to add a transport, auth, storage

- **Transport**: an object with methods `configured, test, upload, job, pause, cancel, command` (see `src/transport/transport.js`); errors are `TransportError`. The implementation is chosen in `src/app/main.js`.
- **OctoPrint auth**: an object `{ init(http), prepare(request), recover(error, attempt), describe(error) }`; run `tests/contract/auth.contract.js` for the new strategy.
- **Storage**: an object `{ load(key), save(key, obj) }` (asynchronous), see `LocalStorageStore` and `ServerStore`. A write failure is an exception with a clear text: the app keeps the value in memory and shows "Could not save the settings".
- **Pre-send check**: a function `(ctx) => Promise<{ level: 'ok'|'confirm'|'block', message }>`; add it to `preflight` in `main.js`.
- **Pen change between layers**: the hook `beforeLayer(layer, index) => string[]` in `generateGcode`.

## Verification with OctoPrint (Virtual Printer)

Manually: enable Virtual Printer in OctoPrint, connect it, in the app "Test connection" → load an SVG → "Upload to OctoPrint" (the file appears in Files) → "Send and print" (the job runs to the end) → on a new job "Pause / resume" and "Cancel" (after cancel a pen lift is sent).
