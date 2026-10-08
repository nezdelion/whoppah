# Whoppah — OctoPrint pen plotter plugin

[Русская версия](README.ru.md)

> — Dad, can we have a pen plotter at home?<br>
> — **W**e **H**ave **O**ur **P**en **P**lotter **A**t **H**ome (WHOPPAH)

Web app for a pen plotter built on a 3D printer controlled by OctoPrint.
Tested on Elegoo Neptune 3 Pro (Marlin) and OctoPrint 1.11.

Drawing (SVG, a photo in one of the line styles, or text) → layout on the sheet → pen G-code → download or send to OctoPrint.

Plain JavaScript (ES modules), no build step and no npm dependencies.

## Contents

- [Running](#running)
  - [GitHub Pages](#github-pages)
- [OctoPrint plugin](#octoprint-plugin)
- [OctoPrint setup](#octoprint-setup)
- [Settings and calibration](#settings-and-calibration)
- [Tabs](#tabs)
  - ["SVG" tab](#svg-tab)
  - ["Photo" tab and styles](#photo-tab-and-styles)
  - ["Text" tab](#text-tab)
- [Interface language](#interface-language)
- [Development](#development)
  - [Structure and dependency rule](#structure-and-dependency-rule)
  - [Tests](#tests)
  - [How to add a drawing source](#how-to-add-a-drawing-source)
  - [How to add a transport, auth, storage](#how-to-add-a-transport-auth-storage)
  - [Plugin development](#plugin-development)
  - [Verification with OctoPrint (Virtual Printer)](#verification-with-octoprint-virtual-printer)
- [License](#license)
- [Third-party code](#third-party-code)
- [Acknowledgements](#acknowledgements)

## Running

```sh
cd plotter
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Does not work from `file://` (ES modules), an http server is required. Recent Firefox and Chromium.

### GitHub Pages

The standalone app is just static files, so it also works from GitHub Pages (or any static hosting) without a local server:

- An HTTPS page can reach OctoPrint at `http://localhost:5000`: browsers treat localhost as trusted (recent Chrome may ask once to allow access to the local network).
- OctoPrint by its LAN address over plain HTTP (`http://octopi.local`, `http://192.168.…`) is blocked as mixed content: serve OctoPrint over HTTPS or use the [OctoPrint plugin](#octoprint-plugin).
- OctoPrint CORS must allow the Pages origin (`https://<user>.github.io`), see [OctoPrint setup](#octoprint-setup).
- Settings live in the localStorage of that origin, separately from `http://localhost:8000`: move them with settings export/import. The API key stays in the browser (it is not in the export file, enter it again).

## OctoPrint plugin

OctoPrint 1.11 can serve the app itself as a full-screen page at `/plugin/plotter/`: no separate server, API key or CORS, and the settings are shared by all devices. Standalone mode keeps working alongside it.

**Install.**

Get a ready zip from [releases](https://github.com/nezdelion/whoppah/releases) or from the artifacts of [CI builds](https://github.com/nezdelion/whoppah/actions/workflows/ci.yml?query=branch%3Amain+is%3Asuccess) (open a run → Artifacts; needs a GitHub login, the downloaded archive contains the plugin zip). Or build it yourself:

```sh
python3 tools/build_plugin.py        # builds dist/OctoPrint-Plotter-<version>.zip
```

OctoPrint → Settings → Plugin Manager → "Get More…" → "… from an uploaded file" → the zip → restart OctoPrint. A "Plotter" link appears in the top bar. To update, install a newer zip the same way; uninstall in Plugin Manager. Each commit gives a higher version (see [Plugin development](#plugin-development)).

**Permissions.**

- Only logged-in users can open the app (others are sent to the OctoPrint login).
- Machine profiles and calibration are shared by everyone; job parameters and presets are per user.
- Changing profiles, including choosing the active one, needs the **"Plotter: Machine profile"** permission (admins have it by default; grant it in Settings → Access Control). Without it profiles are read-only.
- Writing calibration needs **Control**; printing, upload and pause need Print, File Upload and Control.

**Calibration capture.** Bring the pen over with the jog panel or OctoPrint's Control tab, then press "Corner here" or "Touch here" on the "Print" tab (reads the position with `M118`/`M400`/`M114`; not while printing). "Corner is correct" / "Touch is correct" confirm without changing the values. After homing, a printer reconnect or a profile switch the calibration is marked "may be outdated" and printing asks for confirmation. Standalone mode has the same buttons when the printer feed is connected; after a page reload the calibration is considered outdated.

**Homing guard.** The app never sends `G28` on its own: homing with a pen installed can crash it. Until the feed has seen `G28`, capture and the jog panel are off with the hint "Not homed — home before installing the pen". "Home (G28)" homes after you confirm the pen is out or raised; "Already homed" removes the guard until the next reconnect.

**Jog panel.** X±/Y±/Z±, step 0.1/1/10 mm. Stays within the profile axis limits, never more than 2 mm below the touch, and while the pen may be down X/Y stay inside the print area.

**Firmware settings** (standalone with the feed). "Read firmware settings" sends `M503`: a summary, warnings (profile feeds above `M203`, mesh fade below the touch) and "Fill in profile accelerations…". The time estimate then uses the firmware limits.

**Moving settings from standalone.** "Export to file" in standalone, "Import from file…" in the plugin. If the server has no settings for you yet and the browser has standalone settings for the same host:port, the app offers to move them.

Works behind a reverse proxy with a prefix (`X-Script-Name`), e.g. `https://host/octoprint/plugin/plotter/`.

## OctoPrint setup

Standalone mode only:

1. OctoPrint: Settings → API → enable **Enable Cross Origin Resource Sharing (CORS)**, copy the **API key**.
2. App: "Print" tab → "Connection": address (`http://localhost:5000` by default, `http://octopi.local` for OctoPi) and key → "Test connection".

Without them only G-code download works. The key stays in the browser and is not exported with the settings.

## Settings and calibration

All coordinates are the **head (nozzle) position**, as OctoPrint shows them. The pen offset is taken into account through the pen area and the sheet corner.

**Setup wizard.** The "Ready to print" card on the "Print" tab lists what is missing (connection, pen area, sheet corner, touch) with "Set up" per item and "Run setup" for all. Steps, each saved immediately:

1. **Connection** (standalone): address, API key, "Test connection".
2. **Pen area**: the machine profile and where the pen can draw (below).
3. **Sheet**: format and orientation. "Bring the pen to the area corner" and slide the sheet corner under the tip, or jog the pen to the sheet corner; then "Sheet corner here". If the pen cannot reach the corner, use "Pen does not reach the sheet corner".
4. **Touch**: lower Z until the pen touches the paper, "Touch here"; pen width.
5. **Check**: "Pen up", "Trace frame".

**Pen area** — two ways:

- **Pen offset from the nozzle** `dx, dy` (right / away from you is positive). Type it, or put the pen tip on a bed corner and press "Pen here". Example: pen 35 mm right of the nozzle with X limits -4…234 reaches 204 mm along X.
- **Extreme pen positions**: the near left and far right positions of the pen tip.

The editor shows the reach ("Pen reaches: W × H mm") and a map; "Go to" moves to the area corners to check by eye. **Print area** = axis limits ∩ bed.

**Settings panel.**

- **Job** (every time): paper format, orientation, margin, alignment, rotation, "As is in mm", "Limit to print area"; folded **Optimization** and **Calibration values**.
- **Printer** (rarely): machine profiles, pen area, pen heights relative to the touch, feeds, axis limits, pen width, `G28`/`M84`, connection, settings export/import.

**Machine profiles.** A profile = printer + pen holder; up to 20, one active. Job settings, sheet corner and touch do not belong to a profile.

**"Limit to print area"** (on by default): the drawing is fitted into the sheet field minus margins, cut to the print area. Whatever the option, a drawing going past an axis limit or the bed edge asks for confirmation before sending.

**"Go to"** lifts the pen first if needed, moves X/Y and, with a fresh touch, lowers to touch + clearance.

**Settings file.** Export/import at the bottom of the panel: profiles, calibration, job, presets (format 2; format 1 files are rejected). Settings of earlier versions are migrated on first start.

Every button has a hint: on hover on a desktop, behind "?" on touch screens.

## Tabs

### "SVG" tab

Drop an SVG file onto the tab or click to choose one. Shows the number of lines and points and the size in mm if the file sets one. Text and raster images are skipped with a warning — convert text to curves first. The drawing goes to the "Print" tab at once.

### "Photo" tab and styles

Turns a photo into lines: a stack of style layers, each visible layer becomes a drawing layer. Most styles come from [plotterfun](https://github.com/mitxela/plotterfun); its unverified styles give an intermediate result, and printing it asks for confirmation.

**Crop.** "Crop" shows the whole photo with a frame: drag corners and sides to resize, inside to move. "Frame" is free or fits the drawing field. "Reset crop" goes back to the whole photo. The crop belongs to the photo and is not saved in presets.

**Fade background** (strength, size, softness; 0 = off): the image fades to white outside an ellipse in the middle, like an oval engraved portrait. Saved in the tab preset.

#### Wave lines

Parallel lines at a set angle and step (mm); each is a wave whose amplitude and/or frequency grow with darkness. Dark areas get 3 or 5 merged passes, light areas below the break threshold break the line. "Shift every other line by half a period" puts neighbours in antiphase. Presets: fine waves, classic, bold.

Set "Join ends with a stroke up to" (Optimization) to 0, or a bit above the line step to join the serpentine along the edges (faster, but the joins are visible).

#### Engraving

Lines follow the form of the image, like a banknote portrait.

- **Tone**: "Auto levels" stretch a washed-out photo; "Local contrast" brings out mid-tones on a bright background.
- **Direction**: lines run along contours of equal tone, turned by "Rotation from the tone contours". "Field smoothing" (mm) is the size of the forms they follow; "Fine detail" is how much eyes, nose and hair bend them. Flat areas and texture ("Flat area threshold", "Simplify background") turn to the "Base angle"; "Follow the form" 0 % gives straight lines.
- **Spacing and thickness**: "Spacing in dark/light areas" × "Base line spacing"; no line below "Break in light areas". Dark areas get thicker lines with "Thin stroke ends", capped by "Max. ink in shadows"; the darkest areas get a "Cross layer". Strokes shorter than "Min. stroke length" are dropped.
- **Presets**: portrait, banknote, sketch.

If the spacing is too small the layer stops with "Too many lines — increase the spacing". Start with "Join ends with a stroke up to" = 0.

Defaults of both styles are placeholders until a paper test.

### "Text" tab

Writes text with a **single-line font**: each letter is a few strokes along its centre line, drawn once, like a fineliner. Set the cap height (mm), letter and line spacing, slant, alignment, wrap width (0 = no wrap) and "Like by hand". The drawing goes to "Print" on "To print"; it is in mm, and "As is in mm" switches on so letters keep the set height. Text is printed in reading order.

**"Like by hand"** (0–100 %) adds small random size, slant and baseline variation. Same text, settings and seed give the same result; "New variation" picks another seed. Presets: neat, natural, hasty.

**Fonts**: Hershey Script, EMS Felix, EMS Allure (handwriting) and NewStroke (technical). All have Latin, digits and Russian. The handwriting fonts take Cyrillic from NewStroke, so it is italic print, not cursive. Missing characters come from NewStroke or are replaced ("?" with a warning as a last resort).

**Your fonts.** "Add font…" accepts single-line SVG fonts (as from Inkscape's Hershey Text) and Hershey `.jhf`. Outline fonts (TTF/OTF/WOFF, closed-contour SVG) are refused. Stored per user: on the server in plugin mode (up to 1 MB), in the browser in standalone mode. Not part of the settings file.

## Interface language

English, Russian, Spanish, German, French. Chosen in this order: the switch in the page header → the OctoPrint user's language (plugin) → the browser language → English. Switching applies at once, without a reload; the drawing, settings, photo layers and log are kept. Plugin server messages stay in English.

## Development

The rest of this file is for those who change the app itself.

### Structure and dependency rule

```
index.html                entry point
src/core/                 pure functions over Drawing: geometry, svg-import, svg-export, optimize, layout, gcode, profile, profiles, bed, jog, pipeline
src/transport/            Transport interface, OctoPrint REST (fetch), auth by key and by session (plugin)
src/storage/              SettingsStore (localStorage, OctoPrint server), settings file
src/i18n/                 localization: t(key, params), dictionaries en.js / ru.js, language choice (detect.js); imports nothing
src/styles/               "image → lines" styles: registry, runner (workers), style driver, plotterfun adapter, own styles (own/, helpers own/kit/)
vendor/plotterfun/        third-party plotterfun code (unmodified copy), version in vendor/plotterfun/UPSTREAM
vendor/hershey/, vendor/newstroke/, vendor/ems-fonts/   single-line fonts of the "Text" tab (unmodified originals, LICENSE, UPSTREAM)
octoprint-plugin/         OctoPrint Python plugin (page, env.json, settings API, permission)
tools/                    build_plugin.py (zip build), dev_octoprint.sh (local OctoPrint), build_fonts.js (built-in fonts of the "Text" tab)
src/app/                  shell: state, tabs, forms, preview, print service
tests/                    node --test
```

`i18n` → nothing (and does not touch the DOM); `core`, `transport`, `storage`, `styles`, `app` may import `i18n` (core returns ready-made error and warning texts); `core` → only `core` and `i18n`; `transport`, `storage` — likewise only their own layer and `i18n`; `styles` → `core` (`styles/tone.js` and `styles/own/*` including `own/kit/*`, except `own/worker.js` — only `core`, `i18n`, `tone.js` and each other, no DOM); `app` → everything. The rule is checked by `tests/deps.test.js`.
All modules exchange the `Drawing` model (layers of polylines, flat arrays `[x0, y0, x1, y1, ...]`, "document" or "machine" coordinate system).

Processing order (`core/pipeline.js`): import → layout (mm) → simplification → sorting/merging → G-code.

### Tests

```sh
npm test        # or: node --test
```

plotterfun style wrapper (`tests/plotterfun-host.test.js`): by default a fast set (one style per execution model, the "style fails by itself" case, data after final), the whole `node --test` takes about 7 s. Full sweep of 23 styles over parameter variants and two images (about 2 minutes): `PLOTTERFUN_SWEEP=1 node --test tests/plotterfun-host.test.js`; `PLOTTERFUN_FULL=1` additionally sets a 1 s quiet period after final and 5 s for the reference.

Plugin tests: `tools/test_plugin.sh` (arguments go to pytest). The `.venv` in the main checkout is created on first run (OctoPrint 1.11 + pytest) and reused afterwards, including from a worktree; `tools/dev_octoprint.sh` uses the same venv.

Golden G-code for parity with the old implementation: `tests/fixtures/*.gcode`; regenerated by `node tests/tools/gen-golden.js` (uses a copy of the old core `tests/tools/legacy-core.cjs`).

### How to add a drawing source

Create `src/app/tabs/<name>-tab.js`, export a factory of the object `{ id, title, mount(el, ctx), unmount(), dispose?() }` and add it to the tab list in `src/app/main.js`. `mount` may be called again after `unmount` with the same `ctx` (a language switch rebuilds the views): keep the model (loaded data, results, running work) in the factory, not in the view; `unmount` removes only the view's subscriptions and listeners, `dispose` (optional) tears down the model too. A source receives only `ctx`:

- `ctx.emit(drawing)` — emit a drawing (`createDrawing` from `core/drawing.js`, "document" coordinates);
- `ctx.presets.load()/save(obj)` — its own storage area;
- `ctx.printParams.get()/subscribe(fn)` — read-only: field, margin, rotation, pen width.

The "Print" tab does not change. An intermediate result is marked `meta.partial = { reasons: [...] }`.

#### "Photo" tab internals

The "Photo" tab (`src/app/tabs/photo-tab.js`) is an ordinary source: image → stack of style layers → `ctx.emit(drawing)`, each visible layer becomes a drawing layer. Computation runs in workers (`src/styles/runner.js`), a new run of a layer cancels the previous one. A layer gets the "done" status only on a reliable completion signal; for plotterfun styles it is built by the wrapper `src/styles/plotterfun-host.js` from the manifest `src/styles/plotterfun-completion.json` (execution model of each style: `sync`, `async-handler`, `timer-chain`, `none`). The manifest applies only to the commit from the first line of `vendor/plotterfun/UPSTREAM`; after updating vendor run `python3 tools/audit_plotterfun.py` — unverified styles get `none` (the result stays intermediate, printing needs confirmation).

**Crop and fade.** Frame geometry: `src/app/photo/crop.js` (pure functions). The frame gets the whole working resolution (`rasterize(decoded, workingSize, crop)`), so `mmPerPx` and the density check follow it. The crop lives in the tab model (kept across a language switch and a preset) and is not saved: a preset is restored without the photo. Fade background is `applyVignette` in `src/styles/prep.js` (smoothstep, applied to the working image before any style), saved as the `vignette` field of the tab preset.

**Engraving algorithm.** Tone: auto levels by percentiles, CLAHE (8 tiles along the long side). Direction field: smoothed structure tensor of brightness at two scales (fine detail at 1/3 of "Field smoothing"), steep gradients capped; the field depends on auto levels only, not on the other tone settings. Lines: evenly spaced streamlines (Jobard–Lefer) seeded from the centre, converging to at most half the spacing; thickness by 3/5 passes (`thicken`), capped by the distance to the nearest line. Strokes shorter than three spacings are dropped too; placement stops at a point limit.

Status texts of own styles may carry numbers: the worker sends progress as `{ key, params }` (for example `{ key: 'styles.progress.waves', params: { percent: 40 } }` → "Wave lines 40%"), plain strings are dictionary keys or plotterfun texts.

**Engraving stages.** All parameters are live: thickness sliders and "Max. ink in shadows" recompute only the last stage, cross layer sliders do not touch the main lines, the base angle, fine detail and background simplification reuse the tensor, local contrast reuses the field. A style may attach such a note ("Too many lines — increase the spacing") to its final result with `yield { note: { key, params } }`.

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

#### "Text" tab: font interface and rebuilding

Font interface: the layout (`src/core/text-layout.js`) knows only a `StrokeFont` — `{ id, name, capHeight, xHeight, glyphs: Map<code point, { advance, lines }> }` in font units, baseline at y = 0, Y down (`src/core/stroke-font.js`, where the SVG-font and JHF parsers, the outline check and the compact JSON live). A future TTF/OTF centre-line extractor only has to produce the same object.

**Rebuilding the built-in fonts** (after updating `vendor/hershey/`, `vendor/newstroke/` or `vendor/ems-fonts/`): `node tools/build_fonts.js` writes `src/app/text/fonts/*.json` with the same core parsers; `node tools/build_fonts.js --check` only compares (a test runs it, so a forgotten rebuild fails the suite).

#### Interface strings

Dictionaries are flat modules `src/i18n/en.js`, `ru.js`, `es.js`, `de.js`, `fr.js` with stable dotted keys (`print.upload`); a value is a string with `{params}` or plural forms (chosen by `Intl.PluralRules` from the `count` parameter; each entry has every form the language's rules can return: `en`/`de` `{ one, other }`, `es`/`fr` `{ one, many, other }`, `ru` `{ one, few, many, other }`). `t(key, params)`: if the key is missing in the current language, English is used; if missing there too, the key itself. Numbers in text are formatted by `fmtNumber` (`Intl.NumberFormat`: "1.5" / "1,5"); in G-code and input fields always a dot. `tests/i18n.test.js` checks that every language has the same key set and `{name}` parameters as `en`, that every plural entry has all the forms of its language, that all `t('…')` from `src` are in every dictionary, that no sentence is left in English in the other dictionaries (at most two allowed), and that no Cyrillic remains in `src` outside the dictionaries.

**Live language switch** (`createLanguageControl` in `src/app/lang.js`): saves the choice, translates the static markup (`translateStatic`) and remounts every tab view (`src/app/ui/tab-host.js`). Services (state, transport, printer feed, monitors) and tab models are not recreated, so a tab must keep its data in the model, not the view (see [How to add a drawing source](#how-to-add-a-drawing-source)). Texts in schemas, constants and the registry are getters, so they are not frozen in the load-time language.

**Language detection** (`src/i18n/detect.js`): stored choice `whoppah.lang` → plugin `env.json` `language` (user `interface.language`, else `appearance.defaultLanguage`; `_default` = not chosen) → `navigator.languages` by primary subtag → English. Texts produced earlier by core or OctoPrint stay in the old language until produced again.

**New string**: add the key to every dictionary (`en.js`, `ru.js`, `es.js`, `de.js`, `fr.js`, same parameters), in code — `t('key', { param })`. Tests that check Russian texts import `tests/helpers/ru.js` (pins `ru`).

**Button hints.** All buttons are made by `button({ label, hint, onclick })` from `src/app/ui/dom.js`; `tests/buttons.test.js` checks that there is no other `h('button'` and that every hint key exists in `en` and `ru`.

### How to add a transport, auth, storage

- **Transport**: an object with methods `configured, test, upload, job, pause, cancel, command` (see `src/transport/transport.js`); errors are `TransportError`. The implementation is chosen in `src/app/main.js`.
- **OctoPrint auth**: an object `{ init(http), prepare(request), recover(error, attempt), describe(error) }`; run `tests/contract/auth.contract.js` for the new strategy.
- **Storage**: an object `{ load(key), save(key, obj) }` (asynchronous), see `LocalStorageStore` and `ServerStore`. A write failure is an exception with a clear text: the app keeps the value in memory and shows "Could not save the settings".
- **Pre-send check**: a function `(ctx) => Promise<{ level: 'ok'|'confirm'|'block', message }>`; add it to `preflight` in `main.js`.
- **Pen change between layers**: the hook `beforeLayer(layer, index) => string[]` in `generateGcode`.

### Plugin development

**Modes.** On start the app reads `env.json` next to the page: static `{"mode":"standalone"}` — REST with an API key, settings in the browser; the plugin's dynamic `env.json` — OctoPrint session auth (`X-CSRF-Token`), settings on the server, the user's language. Tab and core code does not depend on the mode.

**Version.** MAJOR.MINOR from `octoprint-plugin/octoprint_plotter/_version.py`, PATCH = commits since MAJOR.MINOR was set; uncommitted changes add `.post<UTC time>`; `--version X.Y.Z` sets it exactly. The build does not change tracked files. Page and static files are served with `Cache-Control: no-cache` and ETag.

**Server storage.** A settings section is at most 1 MB, unknown sections are rejected; other devices see a profile switch at the next poll (5 s).

**CI (GitHub Actions, `.github/workflows/ci.yml`).** Every push to `main` and every pull request runs `npm test` and the plugin tests, then builds the plugin zip (downloadable from the run as an artifact). A tag `v*` (e.g. `git tag v0.2.12 && git push origin v0.2.12`) also publishes a GitHub release with the zip; install it in OctoPrint via Plugin Manager → "… from URL" with the release asset link (public repo) or by downloading it.

```sh
tools/dev_octoprint.sh               # .venv + OctoPrint 1.11 + plugin (editable) + Virtual Printer, port 5001, data in .octoprint-dev
tools/test_plugin.sh                 # plugin tests: shared .venv (created once), also works from a git worktree
```

On first launch finish the setup wizard in the browser (first user). The app is copied into the plugin on every script run; after editing `src/` rerun the script (or `python3 tools/build_plugin.py --no-zip`).

API: `GET/PUT /plugin/plotter/api/profiles`, `PUT|DELETE …/profiles/<id>` (with the revision `rev`; a stale one gives 409), `PUT …/profiles/active`; the old `…/api/settings/profile` reads/writes the active profile's values.

### Verification with OctoPrint (Virtual Printer)

Manually: enable Virtual Printer in OctoPrint, connect it, in the app "Test connection" → load an SVG → "Upload to OctoPrint" (the file appears in Files) → "Send and print" (the job runs to the end) → on a new job "Pause / resume" and "Cancel" (after cancel a pen lift is sent).

## License

MIT (`LICENSE`), © 2026 nezdelion. Third-party code and fonts keep their own licenses (below): MIT (plotterfun and its `external/` files), the Hershey Fonts acknowledgement, CC0 (NewStroke), SIL OFL 1.1 (EMS fonts — the license covers the font files only). The OctoPrint plugin imports OctoPrint (AGPLv3) but does not include it; MIT is compatible.

## Third-party code

- **plotterfun** — Tim Alex Jacobs (mitxela), MIT license, <https://github.com/mitxela/plotterfun>. The style files and `helpers.js` are in `vendor/plotterfun/` unmodified together with `LICENSE`; the upstream commit is in `vendor/plotterfun/UPSTREAM`. Update = replace the directory + `tools/audit_plotterfun.py` + recheck the styles with asynchronous code.
- `vendor/plotterfun/external/` holds `rhill-voronoi-core.min.js` (Raymond Hill, MIT, <https://github.com/gorhill/Javascript-Voronoi>) and `stackblur.min.js` (StackBlur, <https://github.com/flozz/StackBlur>), as in upstream; their copyright stays in the file headers.
- **Fonts of the "Text" tab** (originals unmodified in `vendor/<font>/` with `LICENSE` and `UPSTREAM`; the JSON in `src/app/text/fonts/` is generated by `tools/build_fonts.js`):
  - **Hershey Script** (`vendor/hershey/scripts.jhf`, <https://github.com/kamalmostafa/hershey-fonts>): the Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards; the format of the font data was originally created by James Hurt, Cognition, Inc. Free for any use with this acknowledgement (`vendor/hershey/LICENSE`).
  - **NewStroke** (`vendor/newstroke/`, Vladimir Uryvaev, <http://vovanium.ru/sledy/newstroke/en>), CC0 1.0 — also the Cyrillic and punctuation of the other built-in fonts.
  - **EMS Allure**, **EMS Felix** (`vendor/ems-fonts/`, <https://gitlab.com/oskay/hershey-text>): Sheldon B. Michaels, SVG fonts by Windell H. Oskay, derivatives of Allura (Rob Leuschke) and Felipa (Fontstage); SIL Open Font License 1.1. `allure.json` and `felix.json` are modified versions under the same license.

## Acknowledgements

- [Pen plotter graphics software](https://mattwidmann.net/notes/pen-plotter-graphics-software) by Matt Widmann: a collection of links to pen plotting tools.
- [plotterfun](https://mitxela.com/plotterfun) by mitxela ([source](https://github.com/mitxela/plotterfun)): most of the photo styles on the "Photo" tab come from it.
