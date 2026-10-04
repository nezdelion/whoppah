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

1. an explicit choice in the language switch in the page header (Auto / English / Русский, on every tab, standalone and plugin), stored in `localStorage` (`neptune-plotter.lang`);
2. plugin: the interface language of the current OctoPrint user — `language` in the dynamic `env.json` (user setting `interface.language`, otherwise the global `appearance.defaultLanguage`; "_default" means "not chosen");
3. `navigator.languages`: the first supported one (`ru*` → Russian, `en*` → English);
4. otherwise English (including for an unsupported OctoPrint language, e.g. `de`, in which case the browser language is checked).

The language is chosen at startup, before the UI is built. Switching it in the header works **live, without a page reload** (`createLanguageControl` in `src/app/lang.js`): the choice is saved, the language is enabled, the static markup is translated (`translateStatic`), and the views are rebuilt in place (`src/app/ui/tab-host.js` unmounts and mounts every tab again; the header indicator and switch are recreated). Services are not recreated — state (drawing, settings, profiles), transport, the printer feed, the connection and calibration monitors, the firmware/limits memory — and neither are the tab models: the SVG tab keeps the loaded file, the Photo tab keeps its model in `src/app/photo/photo-model.js` (image, layers, parameters, running worker computations, which finish into the new view), the Print tab keeps its log, file name, "travel" and jog step; the active tab and the preview zoom stay too. Messages already shown are recomputed in the new language; texts produced earlier by core or OctoPrint (import warnings, the job log, the connection detail) stay in the old language until they are produced again. Texts that appear in schemas, constants and the registry are computed on access (getters), so they do not get "frozen" in the language at module load. The plugin server (Python) texts stay English: the app shows them only as error details.

**New string**: add the key to both dictionaries (in `en.js` and `ru.js`, same parameters), in code — `t('key', { param })`. Tests that check Russian texts import `tests/helpers/ru.js` (pins `ru`).

## Settings

All coordinates in the app are the **head position** (the nozzle), as shown in OctoPrint; the pen is offset from it, and the app accounts for the offset through the pen area and the sheet corner.

**First setup (wizard).** The "Ready to print" card at the top of the Print tab lists what must be set: connection (standalone only), pen area, sheet corner, touch — each ready / not set / check, with "Set up" per item and "Run setup" for the whole wizard. The wizard is a modal dialog with steps, every change is saved at once, it can be closed on any step:

1. **Connection** (standalone): OctoPrint address and API key, the indicator, "Test connection".
2. **Pen area**: the machine profile (printer + pen holder) and where the pen tip can draw, one of two ways (below).
3. **Sheet**: format and orientation; put the sheet on the bed, then either "Bring the pen to the area corner" (the pen hovers over the near left corner of the pen area — slide the sheet corner under the pen tip) or jog the pen to the sheet corner; then "Sheet corner here". "Pen does not reach the sheet corner" holds the pen offset from the corner for that case.
4. **Touch**: lower Z step by step until the pen touches the paper, "Touch here"; pen width.
5. **Check**: the readiness list, "Pen up", "Trace frame" (when a drawing is loaded).

Steps that move the head have the jog pad (step 0.1/1/10 mm, X±/Y±/Z±) and the "Not homed" guard with "Already homed". Without a position source (no plugin feed) the steps show the number fields only.

**Pen area** (the active profile). Two ways, chosen by a switch; both fill the same bed rectangle of the profile:
- **Pen offset from the nozzle** `dx, dy` (to the right / away from you — positive; the pen closer to you than the nozzle is a negative `dy`): the bed in head coordinates is the nominal bed (default 235×235 mm) shifted by −offset, the far corner "by nominal". Enter the numbers, or bring the pen tip to any bed corner it reaches, choose that corner and press "Pen here": the offset is corner − head position. Example: pen 35 mm right of the nozzle, limits X-4…234 — the pen reaches 204 mm along X.
- **Extreme pen positions**: the near left and far right positions of the pen tip over the bed — "Use current position" or numbers; stored as measured corners.
The editor shows "Pen reaches: W × H mm", a map (bed, axis limits, pen area, sheet) and "Go to" the area corners to check by eye. **Print area** = axis limits ∩ bed; the area not set — the axis limits, and the pen-on-bed checks are skipped with a note. The bed has no coordinate epoch (homing does not make it stale).

Settings panel layout:

- **Ready to print** card, then **Job** (every time): paper format (custom formats are saved), orientation, margin, alignment, rotation, "as is in mm", "Limit to print area"; folded **Optimization** (simplification and merge tolerances) and **Calibration values** (sheet corner and touch as numbers, with the date).
- **Printer** (folded, rarely): **machine profiles**, the pen area editor, pen heights as offsets from the touch, feeds, axis limits, pen width, `G28`/`M84`, connection (standalone), settings export/import. The fold states are remembered in the browser.
- The calibration card on the right: the "may be outdated" warning with "Corner is correct" / "Touch is correct", the jog pad and "Set up…".

**Machine profiles.** A profile is "printer + pen holder": up to 20 named profiles, one active; New (defaults), Duplicate, Rename, Delete (not the last one; deleting the active one makes the neighbour active). Layout, G-code, checks, the jog panel and the time estimate use the active profile; the job settings, the sheet corner and the touch are not part of a profile and do not change on a switch. The corner and the touch depend on the holder, so after a profile switch both are reported as "may be outdated (the machine profile changed)" and printing asks for confirmation, until a new capture, input or "Corner is correct" / "Touch is correct" (back to the previous profile — fresh again). The single profile of earlier versions becomes the profile "Neptune 3 Pro" on the first start (standalone: in the browser, plugin: on the server); the old data is kept.

**"Limit to print area"** (job, on by default, marked ⚠): the drawing is fitted (scale and alignment) into (sheet field − margins) ∩ (print area moved to sheet coordinates via the corner); the sheet itself may extend beyond the area (a warning per side). Off: the drawing is fitted into the sheet as before. If the field minus margins is inside the print area, the G-code is the same with the option on or off. Before sending, the drawing is checked against the print area regardless of the option: beyond an axis limit or beyond the bed edge (per side, in mm) — confirmation.

**Point and "Go to".** Every point in head coordinates (sheet corner, pen positions) is the same control: X/Y, "Use current position", "Go to". "Go to" reads the position, lifts the pen to the start height if it is lower (or unknown), moves X/Y and, with a fresh touch, lowers to touch + clearance; a point outside the axis limits is refused. Same guards and permissions as the jog panel.

Settings export/import via a file is at the bottom of the settings panel: format version 2 (all profiles with the active one, calibration, job, presets); a version 1 file (a single profile) is rejected with "the old settings file format is not supported". Settings of the old page (`neptune-plotter.settings`) are migrated once on first launch.

**Button hints.** Every button has a short hint (dictionary key `<area>.<button>.hint`): the hover title on a desktop, a "?" next to the button on touch screens (shows the text under the button). All buttons are made by `button({ label, hint, onclick })` from `src/app/ui/dom.js`; `tests/buttons.test.js` checks that there is no other `h('button'` and that every hint key exists in `en` and `ru`.

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
- The machine profiles (with the active one) and calibration are shared by everyone; job parameters and presets are per user. Another device's profile switch is picked up with the next poll (5 s).
- Any profile write — values, bed, create, duplicate, rename, delete **and choosing the active profile** — requires the **"Plotter: Machine profile"** permission (`PLUGIN_PLOTTER_MACHINE_PROFILE`): the administrators group has it by default; it is granted in Settings → Access Control (to a user or group). Without the permission the profiles are shown read-only. API: `GET/PUT /plugin/plotter/api/profiles`, `PUT|DELETE …/profiles/<id>` (with the revision `rev`; a stale one gives 409), `PUT …/profiles/active`; the old `…/api/settings/profile` reads/writes the active profile's values.
- Writing the calibration requires the standard OctoPrint **Control** permission. Print, upload and pause are checked against OctoPrint permissions (Print, File Upload, Control); on denial "permission required: …" is shown.
- A section is at most 1 MB; unknown sections are rejected by the server.

**Calibration capture and jog panel.** Bring the pen over with the standard Control tab, then on the "Print" tab press "Corner here" (accounting for the pen offset from the sheet corner) or "Touch here"; the position is read with `M118`/`M400`/`M114` (unavailable while printing). "Corner is correct" / "Touch is correct" confirm a part without changing values. After homing (`G28`) or a printer reconnect the app shows "calibration may be outdated", and printing requires confirmation. Requires the Control permission and firmware that answers `M118`.

The same buttons exist in standalone when the printer feed is connected: the calibration lives in the browser and the coordinate epochs in the feed memory, so after a page reload both parts are considered outdated until a new capture or "Corner is correct" / "Touch is correct". Until the feed has seen `G28` (since connecting to the printer; Home is tracked separately for XY and Z), capture and the jog panel are disabled with the hint "Not homed — home before installing the pen"; the app never sends `G28` itself; if Home was done before the page was opened (`G28` is dangerous with a pen), the "Already homed" button with confirmation removes the guard until the next reconnect, and does not change the coordinate epochs. The jog panel (X±/Y±/Z±, step 0.1/1/10 mm, both modes) reads the position before each step, does not go beyond the profile axis limits, and Z not more than 2 mm below the touch; with a measured bed, while the pen may be down (Z unknown or below touch + clearance) X/Y stay in the print area, and off the bed Z stays at touch + clearance or higher.

**Firmware settings (standalone, feed connected).** "Read firmware settings" ("Connection" section) sends `M503` and parses `M201`/`M203`/`M204`/`M205`/`M420`: a summary, warnings (profile feeds above `M203`, mesh fade below the touch), "Fill in profile accelerations…" on confirmation. The result is kept only in memory, until the feed drops; while it exists, the time estimate clamps feeds by `M203` and starts from the `M205` jerk (marked "accounting for firmware"). The plugin has no feed — not available there.

**Transferring settings from standalone.** In standalone: "Export to file" at the bottom of the settings panel; in the plugin: "Import from file…". The profiles and calibration are skipped with a message if permissions are missing, the rest is imported. If the user has no settings on the server yet, but `localStorage` of the same address (host:port) has standalone settings, the app offers to transfer them itself.

**Development.**

```sh
tools/dev_octoprint.sh               # .venv + OctoPrint 1.11 + plugin (editable) + Virtual Printer, port 5001, data in .octoprint-dev
tools/test_plugin.sh                 # plugin tests: shared .venv (created once), also works from a git worktree
```

On first launch finish the setup wizard in the browser (first user). The app is copied into the plugin on every script run; after editing `src/` rerun the script (or `python3 tools/build_plugin.py --no-zip`). Behind a reverse proxy with a prefix (`X-Script-Name`) the URLs are built from `script_root`, and the app opens at `https://host/octoprint/plugin/plotter/`.

## Structure and dependency rule

```
index.html                entry point
src/core/                 pure functions over Drawing: geometry, svg-import, svg-export, optimize, layout, gcode, profile, profiles, bed, jog, pipeline
src/transport/            Transport interface, OctoPrint REST (fetch), auth by key and by session (plugin)
src/storage/              SettingsStore (localStorage, OctoPrint server), settings file
src/i18n/                 localization: t(key, params), dictionaries en.js / ru.js, language choice (detect.js); imports nothing
src/styles/               "image → lines" styles: registry, runner (workers), style driver, plotterfun adapter, own styles (own/, helpers own/kit/)
vendor/plotterfun/        third-party plotterfun code (unmodified copy), version in vendor/plotterfun/UPSTREAM
octoprint-plugin/         OctoPrint Python plugin (page, env.json, settings API, permission)
tools/                    build_plugin.py (zip build), dev_octoprint.sh (local OctoPrint)
src/app/                  shell: state, tabs, forms, preview, print service
tests/                    node --test
```

`i18n` → nothing (and does not touch the DOM); `core`, `transport`, `storage`, `styles`, `app` may import `i18n` (core returns ready-made error and warning texts); `core` → only `core` and `i18n`; `transport`, `storage` — likewise only their own layer and `i18n`; `styles` → `core` (`styles/tone.js` and `styles/own/*` including `own/kit/*`, except `own/worker.js` — only `core`, `i18n`, `tone.js` and each other, no DOM); `app` → everything. The rule is checked by `tests/deps.test.js`.
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

Create `src/app/tabs/<name>-tab.js`, export a factory of the object `{ id, title, mount(el, ctx), unmount(), dispose?() }` and add it to the tab list in `src/app/main.js`. `mount` may be called again after `unmount` with the same `ctx` (a language switch rebuilds the views): keep the model (loaded data, results, running work) in the factory, not in the view; `unmount` removes only the view's subscriptions and listeners, `dispose` (optional) tears down the model too. A source receives only `ctx`:

- `ctx.emit(drawing)` — emit a drawing (`createDrawing` from `core/drawing.js`, "document" coordinates);
- `ctx.presets.load()/save(obj)` — its own storage area;
- `ctx.printParams.get()/subscribe(fn)` — read-only: field, margin, rotation, pen width.

The "Print" tab does not change. An intermediate result is marked `meta.partial = { reasons: [...] }`.

### "Photo" tab and styles

The "Photo" tab (`src/app/tabs/photo-tab.js`) is an ordinary source: image → stack of style layers → `ctx.emit(drawing)`, each visible layer becomes a drawing layer. Computation runs in workers (`src/styles/runner.js`), a new run of a layer cancels the previous one. A layer gets the "done" status only on a reliable completion signal; for plotterfun styles it is built by the wrapper `src/styles/plotterfun-host.js` from the manifest `src/styles/plotterfun-completion.json` (execution model of each style: `sync`, `async-handler`, `timer-chain`, `none`). The manifest applies only to the commit from the first line of `vendor/plotterfun/UPSTREAM`; after updating vendor run `python3 tools/audit_plotterfun.py` — unverified styles get `none` (the result stays intermediate, printing needs confirmation).

**Crop and "Fade background".** "Crop" on the preview shows the whole photo with a frame: drag a corner or a side to resize it, drag inside to move it (mouse or finger; the preview zoom is off in this mode). "Frame" chooses free proportions or the proportions of the drawing field (field minus margins, inverse when rotated; switching it on fits the frame at once). The layers are recalculated once, when the frame is released; "Reset crop" draws the whole photo again. The frame gets the whole working resolution (`rasterize(decoded, workingSize, crop)`), so the paper scale `mmPerPx` and the density check follow it: a frame of half the photo lies on the same field twice as large. "Fade background" (strength, size, softness; strength 0 = off) is one setting for all layers: outside an ellipse in the middle of the frame (100 % — inscribed in it) the image fades toward white with a smoothstep over the softness (`applyVignette` in `src/styles/prep.js`, applied to the working image before any style), so light lines vanish toward the edges like an oval engraved portrait; a change recalculates the layers after the same delay as a layer parameter. The frame belongs to the photo: it lives in the tab model (kept across a language switch and a preset), a new file resets it, and it is not saved — a preset is restored without the photo, and the frame of one photo would cut a random part of another. "Fade background" is saved with the layers in the tab preset (`vignette` field; a preset without it switches it off). The frame geometry is in `src/app/photo/crop.js` (pure functions).

Status texts of own styles may carry numbers: the worker sends progress as `{ key, params }` (for example `{ key: 'styles.progress.waves', params: { percent: 40 } }` → "Wave lines 40%"), plain strings are dictionary keys or plotterfun texts.

#### Adding your own style

The simple way: a pure function `(gray, w, h, params, paper) => lines` (lines are `Float64Array` polylines in working-image px) in `src/styles/own/`, an entry `'own:<name>': plain(fn, 'styles.progress.<key>')` in the `IMPL` table of `src/styles/own/worker.js` and a descriptor in `src/styles/registry.js` (`crosshatch` works like this).

A style with live sliders is a staged generator (`src/styles/own/waves.js` is the example):

```js
function* mySteps({ gray, w, h, params, paper, cache }) {
  const dark = stage(cache, 'tone', [params.invert, params.gamma], () => toDarkness(gray, params));       // cached stage
  const geo = yield* stageGen(cache, 'geo', [dark, params.spacing], function* () { /* yield progressOf(KEY, f) */ });
  return stage(cache, 'finish', [geo, params.passes], () => /* Float64Array[] */);
}
export const myStyle = (gray, w, h, params, paper) => runToEnd(mySteps({ gray, w, h, params, paper, cache: createCache() }));
```

It is registered as `staged(mySteps)` in `IMPL`. The worker runs it through the driver `src/styles/style-driver.js`: in time slices (30 ms; messages are handled in between), progress at most every 200 ms, `yield { partial: lines }` sends an intermediate result, the return value is the final one. Parameters marked `live: true` go to the running worker; the latest value wins (the current generator is dropped at the next slice boundary and restarted with the same stage cache, so only the stages whose dependencies changed are recomputed; a dropped stage stores nothing). Stage dependencies are compared with `===`; pass the upstream stage value as a dependency to chain them. The result must depend only on the image, the parameters and `paper` — a live change gives exactly what a fresh run gives (tests check it).

Descriptor fields beyond `id, name, group, origin, params, adapter, createWorker, spacing`:

- `usesPaper: true` — size parameters are in mm on paper. The run gets `paper = { mmPerPx, penWidthMm }` (`mmPerPx` — the "working px → mm" scale of the density check, from the field minus margins and the rotation; without print parameters 0.25 mm/px and a 0.5 mm pen); the tab recomputes the layer when the field, margin, rotation or pen width change that scale. The scale assumes the drawing fills the image (the layout fits the drawing's bounding box), "Limit to print area" is not taken into account yet. `spacing(params, image, paper)` returns the line step in px for the density check.
- `presets: [{ id, label, params }]` — style presets: the layer card gets a "Preset" row (values = the defaults overlaid with the preset, the layer restarts); the values are saved in the tab preset as usual.
- a `select` parameter may have `optionLabel(value)` — the shown text of an option (the value itself does not depend on the language).

Shared pure helpers in `src/styles/own/kit/` (no DOM, usable in node tests): `params.js` (`paramFactory(prefix)` — lazy labels `t('<prefix>.param.<key>')` and option labels `t('<prefix>.<key>.<value>')`; `presetFactory(prefix)` — `t('<prefix>.preset.<id>')`; `presetValues`, `matchPreset`), `paper.js` (`DEFAULT_PAPER`, `paperOf`, `mmToPx`, `samePaper`), `lines.js` (`lineFamily` — parallel lines through the image clipped to it, `clipLine`, `arcLengths`, `dropShort`), `stroke.js` (`thicknessProfile`, `thicken` — line thickness by 1/3/5 close passes inside one continuous polyline with tapered "lenses", `endTaperPx` for thin stroke ends), `order.js` (`orientChain`, `orientGroups` — stroke directions for short travels, a serpentine for line families), `stages.js` (`createCache`, `stage`, `stageGen`, `runToEnd`, `progressOf`). Also `toDarkness` (with `gamma`), `boxBlur`, `sampleBilinear` from `src/styles/tone.js` and `simplifyLine` from `src/core/optimize.js`. All texts go through `t()`: add the `<prefix>.param.*`, option and preset keys to `en.js` and `ru.js` and the style to `OWN_PREFIX` in `tests/i18n.test.js`.

#### Wave lines

Parallel lines at an angle and step (mm on paper); each line is a wave whose amplitude, frequency or both grow with the darkness of its band; in dark areas the line gets thicker by up to 3 or 5 passes `pass pitch × pen width` apart (they merge into one thick line; the pen is not lifted inside a stroke); in light areas below the break threshold the line stops (highlights shorter than one step do not break it). The amplitude is capped so that neighbouring lines at full thickness do not touch; "Shift every other line by half a period" puts neighbours in antiphase (off — in phase). The lines come out as a serpentine. Three presets: fine waves, classic (the defaults), bold. The defaults are placeholders until a paper test.

With wave lines set "Join ends with a stroke up to" (`linkTolMm`, Optimization) either to 0, or deliberately a bit more than the line step: then neighbouring lines of the serpentine are joined by a stroke along the image edge or the edge of a light area — faster, but the joins are visible as an outline. A value below the step joins nothing.

#### Engraving

Lines follow the form of the image, like a portrait on a banknote. The tone of a real photo is prepared first: "Auto levels" (on by default) stretch the brightness range between the percentiles "Auto levels: clipping, %" and 100 − it, so a washed-out photo gets its blacks and whites; "Local contrast, %" mixes in a contrast-limited adaptive histogram equalisation (CLAHE, 8 tiles along the long side), so a light face against a bright background still gets readable mid-tones.

The direction field is the smoothed structure tensor of the brightness at two scales: lines run along the contours of equal tone (isophotes), turned by "Rotation from the tone contours" (90° — across them, e.g. around a cylinder lit from the side). "Field smoothing" (mm) is the size of the forms the lines follow (the oval of a face, a fold of cloth); "Fine detail, %" is how far the detail at a third of that scale (eyes, nose, strands of hair) bends them — 0 % only the large form, 100 % the detail fully. Very steep gradients (a silhouette, a hair line) enter the field capped, so lines beside an edge do not all run along it. Where the brightness hardly changes ("Flat area threshold" — brightness change per 1 cm on paper, %), the structure has no clear direction, or the area is texture rather than form (foliage, grass, noise — "Simplify background, %": the higher, the more of it goes to the base angle), the lines turn smoothly to the "Base angle"; "Follow the form" 0 % gives straight parallel lines everywhere. The field depends on the auto levels but not on brightness, contrast, gamma, inversion and local contrast — they only change the tone.

The lines are evenly spaced streamlines (Jobard–Lefer): the distance between neighbours goes from "Spacing in dark areas" to "Spacing in light areas" (both × "Base line spacing", mm), lines converge to at most half of it and stop there; below "Break in light areas" the line is not drawn (a highlight narrower than about two light spacings interrupts it, and it continues on the same track). The first line starts at the image centre, the next ones beside it, so neighbouring lines are drawn one after another. In dark areas a line gets thicker by 3 or 5 merging passes (as wave lines) with "Thin stroke ends" like a burin cut, but never wider than "Max. ink in shadows, %" of the distance to the nearest other line (shadows keep thin white lines instead of a black fill); in the darkest areas ("Cross layer from darkness") a second family of thin lines at "Cross layer angle" is drawn on top, in the same drawing layer (one pen). Strokes shorter than "Min. stroke length" or than three line distances are dropped (no clutter of short strokes in textured areas), a line is never longer than "Max. line length". Presets: portrait (the defaults), banknote (dense even long lines, tone by thickness, calm background, no cross layer), sketch (sparse short lines that follow more detail, cross layer in shadows). The defaults are placeholders until a paper test.

All parameters are live: thickness sliders and "Max. ink in shadows" recompute only the last stage, cross layer sliders do not touch the main lines, the base angle, fine detail and background simplification reuse the tensor, local contrast reuses the field. The status shows the phases ("Direction field", "Lines 45%", "Cross layer 70%", "Finishing"), the main lines appear before the end. If the spacing is too small for the image the placement stops at a point limit and the layer shows "Too many lines — increase the spacing" next to "done" (a style may attach such a note to its final result with `yield { note: { key, params } }`).

For engraving start with "Join ends with a stroke up to" (`linkTolMm`) 0: line ends are not on one edge as with wave lines, so joining them draws visible strokes across the picture.

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
