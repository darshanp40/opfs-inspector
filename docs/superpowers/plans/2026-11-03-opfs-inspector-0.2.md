# OPFS Inspector 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 0.1.0 panel into the richest, best-looking OPFS explorer in the stores ("modern app" look B), with a read-only SQLite viewer, while the inspected page stays as light as 0.1.0.

**Architecture:**
- The page side stays hand-written and gets a few new operations (`src/ops.js`, `src/agent.js`, `src/background.js`).
- The panel moves to ES modules under `panel/`, which esbuild bundles to `build/`.
- Heavy parts load on first use, as separate bundles: CodeMirror, the Markdown renderer, fflate, and sql.js running in a worker.
- The panel still talks to the page only through `transport.call(op, args)`, so the Playwright harness keeps working.

**Tech Stack:** MV3 WebExtension, plain JS (ES2022), esbuild, CodeMirror 6, marked plus DOMPurify, fflate, sql.js, Playwright (`node --test`), axe-core.

**Spec:** `docs/superpowers/specs/2026-11-03-opfs-inspector-0.2-design.md`

## Global Constraints

- **Browsers:** Chrome, Edge, Firefox 128 or later, and Safari, all from one MV3 manifest. Keep `background.service_worker` plus `background.scripts`, and keep the gecko id.
- **Page weight:**
  - Nothing runs in the inspected page until the panel calls it.
  - Page code is only `src/ops.js` and `src/agent.js`, with no build step and no libraries.
  - All UI, parsing, zip and SQLite work happens in the panel.
- **Page code safety rules:** no file or folder handles are kept between operations, and `storageBuckets.open()` is called only for a name that `keys()` lists.
- **Panel speed:** the tree shows within 300 ms of opening the panel, with a 1,000-file folder.
- **Loaded on first use**, never at panel start: the editor, Markdown, zip and SQLite bundles.
- **Size limits:** editor 2 MB, image preview 5 MB, SQLite snapshot 200 MB. Above a limit, offer Download. Show progress above 5 MB.
- **No remote code.** Manifest CSP: `"content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"}`.
- **Permissions:** no new ones beyond `scripting` and `<all_urls>`.
- **Site content is untrusted.** Sanitise Markdown with DOMPurify. Show images, including SVG, only through `<img src=blob:>`.
- **Libraries:** MIT, BSD, Apache-2.0 or public domain only. Their notices ship in `build/THIRD_PARTY.txt`.
- **Accessibility:** WCAG 2.1 AA in light, dark and `forced-colors`. The tree follows the ARIA tree pattern. Changes are announced through the existing `#status` live region.
- **Commits:** every commit is made with `git -c user.name="Darshan Pawar" -c user.email="11847144+darshanp40@users.noreply.github.com" commit ...`. Messages name no tool or assistant, and carry no Co-Authored-By line.
- **Tests:** after every task, `npm test` passes (WebKit is still skipped with its reason) and `npm run lint:firefox` shows 0 errors.

## Review Focus

1. **A folder with 10,000 entries:** the tree stays smooth and keyboard navigation works. Test in Task 4.
2. **Moving a folder into itself or into one of its own subfolders:** the move is refused with a clear message, and nothing is copied. Test in Task 2 (ops) and Task 6 (drag).
3. **Name clashes on move, duplicate or upload:**
   - Duplicate picks `name copy`, `name copy 2`, and so on.
   - Move and upload refuse or skip the clashing name and report it.
   - Tests in Tasks 2 and 6.
4. **Hostile file content:** Markdown with `<script>`, `onerror=`, `javascript:` links or `<iframe>`, and an SVG with script, never run in the panel. Tests in Tasks 9 and 10.
5. **A database that changes while it is being copied:** the snapshot is retried, never torn, and after 3 failed tries the card says so. Test in Task 11.

---

### Task 1: Build step and module split, no visible change

**Files:**
- Create: `panel/main.js`, `panel/transport.js`, `panel/state.js`, `panel/format.js`, `panel/tree.js`, `panel/detail.js`, `panel/actions.js`, `scripts/build.mjs`
- Delete: `panel.js` (its code moves into `panel/`)
- Modify:
  - `panel.html`: load `build/panel.js` as `type="module"`.
  - `manifest.json`: add the CSP, set version `0.2.0`.
  - `package.json`: add `build`, make `test` and `package` run `build` first. Add devDeps `esbuild`.
  - `scripts/package.sh`: include `build/`, leave out `panel/`.
  - `test/server.mjs`: harness replacement now targets `<script type="module" src="build/panel.js"></script>`.
  - `.gitignore`: add `build/`.
  - `README.md`: Files section.

**Interfaces:**
- Produces:
  - `transport.js`: `call(op, args) -> Promise<value>`, which throws `Error(message)`, and `onNavigated(listener)`.
  - `format.js`: `formatSize(n) -> string`, `toBase64(Uint8Array) -> string`, `fromBase64(string) -> Uint8Array`, `join(dir, name)`, `parentOf(path)`, `baseName(path)`.
  - `state.js`: the exported `state` object (0.1.0 fields), `currentArea() -> area`, and `setStatus(message, kind)`.
  - `scripts/build.mjs`: bundles every `panel/*.entry.js` and `panel/main.js` to `build/`, with code splitting on (`splitting: true, format: 'esm'`). It also copies `node_modules/sql.js/dist/sql-wasm.wasm` to `build/` when present, and writes `build/THIRD_PARTY.txt` from the licences of the bundled packages.

- [ ] **Step 1:** Run `npm test` and record the pass count as the baseline (expect 44 pass, 2 skipped).
- [ ] **Step 2:** Move the code out of `panel.js` into the modules above, with the same behaviour. `main.js` holds the start-up code.
- [ ] **Step 3:** Run `npm run build && npm test`. Expected: the same counts as Step 1.
- [ ] **Step 4:** Run `npm run package && unzip -l dist/opfs-inspector-0.2.0.zip`. Expected: `build/panel.js` is listed, and no `panel/` or `node_modules/` files are.
- [ ] **Step 5:** Commit: `build: bundle the panel with esbuild`.

### Task 2: New page operations

**Files:**
- Modify: `src/ops.js`
- Test: `test/ops.test.mjs`

**Interfaces:**
- Produces (each through `run(op, args)`; the result is `{ok, value}` or `{ok:false, error}`):
  - `copy({area, path, toDir, newName?}) -> {path}`
    - With no `newName`, it picks `"<stem> copy<ext>"`, then `"<stem> copy 2<ext>"`, and so on. For folders, the "extension" part is empty.
  - `move({area, path, toDir}) -> {path}`
    - Throws `"A folder cannot be moved into itself."` when `toDir === path` or `toDir` starts with `path + '/'`.
    - Throws `"\"<name>\" already exists in <toDir or />."` on a clash.
    - Uses `handle.move(targetDirHandle)`, falling back to copy then delete.
  - `dirSize({area, path, recursive}) -> {bytes, files, folders}`. Files a database holds open still count, because `getFile()` works on them.
  - `estimate({area}) -> {usage, quota}`. For a bucket, this is `bucket.estimate()`. For the default storage, it is `navigator.storage.estimate()`. When the API is missing, it returns `{usage: null, quota: null}`.
  - `stat({area, path}) -> {kind, size, lastModified}`. Used by the snapshot check in Task 11.

- [ ] **Step 1:** Write the failing tests in `test/ops.test.mjs`, inside the existing engine loop:
  - `copy picks a free name`: copying `a.txt` twice in the same folder gives `a copy.txt` and `a copy 2.txt`, with the same bytes.
  - `copy duplicates a folder with its contents`.
  - `move into another folder`: `x/a.txt` to `y` gives `y/a.txt`, and `x/a.txt` is gone.
  - `move refuses a folder into itself`: moving `x` to `x/sub` gives `error` matching `/cannot be moved into itself/`, and `x/sub` has no `x` inside.
  - `move refuses a clash`: the error matches `/already exists/`, and both files are unchanged.
  - `dirSize own vs recursive`: `{bytes: 3, files: 1, folders: 1}` versus `{bytes: 8, files: 2, folders: 1}` for the fixture `d/a(3 B)`, `d/s/b(5 B)`.
  - `estimate returns numbers in Chromium`, with `usage >= 0` and `quota > 0`.
  - `stat returns size and lastModified`.
- [ ] **Step 2:** Run `ENGINES=chromium,firefox node --test test/ops.test.mjs`. Expected: the new tests fail with `Unknown operation`.
- [ ] **Step 3:** Implement the five operations in `src/ops.js`, reusing `copyInto`, `exists`, `parentAndName` and `dirAt`.
- [ ] **Step 4:** Run the same command. Expected: all pass.
- [ ] **Step 5:** Commit: `feat: copy, move, folder size, estimate and stat operations`.

### Task 3: The modern look (B)

**Files:**
- Modify: `panel.html`, `panel.css`, `panel/main.js`, `panel/tree.js`, `panel/detail.js`
- Create: `panel/theme.js`, `panel/icons.js`
- Test: `test/ui.test.mjs`. Add devDep `@axe-core/playwright`.

**Interfaces:**
- Produces:
  - `icons.js`: `iconFor(entry) -> SVGElement`. `entry` is `{name, kind}`. The types are folder, text, json, code (js/ts/mjs/css/html), markdown, image, sqlite (by extension `.db`, `.sqlite`, `.sqlite3`, or the header shown in the detail view), and binary. The icons are inline SVG using `currentColor`.
  - `theme.js`: `applyTheme()`. It sets `document.documentElement.dataset.theme` to `'dark'` or `'light'` from `devtools.panels.themeName` (`'dark'` means dark), falling back to `prefers-color-scheme`.
  - The DOM layout, in `panel.html`. Tests use these ids:
    - The header holds the icon buttons and `#crumbs`, a `<nav aria-label="Path">` with one button per part. The storage pill `#area` is a `<select>` styled as a pill at the top right.
    - `#tree` is on the left.
    - `#card` is on the right, with `#card-tabs` (`role="tablist"`) and `#card-body`.
    - `#footer` has `#usage` text and a `<meter id="usage-meter">`.
  - The card's tabs come from the type: `Editor` and `Details` for text, `Preview` and `Details` for images, `Preview`, `Editor` and `Details` for Markdown, and `Table`, `Query` and `Details` for SQLite. Other files get `Bytes` and `Details`, and folders get `Details`. In this task, only `Editor`, `Bytes` and `Details` work. The others appear in later tasks.

- [ ] **Step 1:** Write the failing tests:
  - `clicking a path part selects that folder`.
  - `footer shows usage`: `#usage` matches `/of/`.
  - `rows have type icons`: `.row svg` count equals the row count.
  - `dark theme`: with `emulateMedia({colorScheme:'dark'})` and a reload, `data-theme` is `dark`.
  - `axe finds no serious violations` in light, dark and `forcedColors:'active'`: `AxeBuilder(...).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()` gives no `serious` or `critical` violations.
- [ ] **Step 2:** Run `ENGINES=chromium,firefox node --test test/ui.test.mjs`. Expected: the new tests fail.
- [ ] **Step 3:** Build the layout and CSS tokens from mockup B, defining tokens for light, dark and `@media (forced-colors: active)`. Use `estimate` from Task 2 for the footer, refreshed on Refresh and after each write.
- [ ] **Step 4:** Run the same command. Expected: all pass, including every 0.1.0 UI test, with selectors updated only where ids moved.
- [ ] **Step 5:** Commit: `feat: modern panel layout with type icons, path bar and storage footer`.

### Task 4: Accessible tree, selecting several items, and large folders

**Files:**
- Modify: `panel/tree.js`, `panel/state.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces:
  - `state.selection: Set<path>`, with `state.anchor: path` for Shift ranges. `state.selected` stays as the "focused" item that the card shows.
  - `onSelectionChange(listener)` in `state.js`.
  - The tree DOM: `#tree[role=tree][aria-multiselectable=true]`, with rows as `[role=treeitem][aria-level][aria-expanded?][aria-selected]`, and one roving `tabindex=0`.
  - Rendering is virtual: only rows in view (plus a 20-row buffer) are in the DOM. A spacer gives the full height. Row height is fixed by a CSS token.

- [ ] **Step 1:** Write the failing tests:
  - `arrow keys move focus, Right expands, Left collapses`.
  - `Ctrl/Cmd+click adds, Shift+click selects a range, Ctrl/Cmd+A selects all in view`: the count of `[aria-selected=true]` equals the expected count.
  - `10,000 files`: seed one folder with 10,000 empty files through `page.evaluate`, then expand it.
    - The tree shows its first row within 1,500 ms.
    - `.row` count in the DOM is under 200.
    - Pressing End focuses the last file, by name.
  - `panel opens fast`: with a 1,000-file root, the time from `goto` to the first `.row` is under 300 ms. Measure with `performance.now()` in the page, take the median of 3 runs, and run it in Chromium only.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the ARIA tree keyboard model (Up, Down, Home, End, Left, Right, Enter, and typing a letter to jump), selection, and the virtual list.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: keyboard tree with multi-select and virtual rows`.

### Task 5: Shortcuts, right-click menus and the help overlay

**Files:**
- Create: `panel/commands.js`, `panel/menu.js`
- Modify: `panel/main.js`, `panel/tree.js`, `panel.html`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces:
  - `commands.js`: `register({id, label, keys, when, run})` and `commandsFor(context) -> Command[]`.
    - `keys` is a string such as `'Mod+Shift+N'`. `Mod` means Cmd on macOS (`navigator.platform` or `userAgentData`) and Ctrl elsewhere. `shortcutLabel(keys) -> '⌘⇧N' | 'Ctrl+Shift+N'`.
    - `when(state) -> boolean` enables or disables the command.
    - Toolbar buttons, menus and tooltips all come from this one registry.
  - `menu.js`: `openMenu(x, y, commands)`. It is an ARIA `menu` with arrow keys, Escape and Enter, and returns focus to the tree when closed.
  - At least 20 commands, as named below. Avoid DevTools' own shortcuts (`Mod+[`, `Mod+]`, `Mod+P`, `Mod+Shift+P`, `Mod+F`, `Mod+Shift+C`, `F1`):
    - `new-file` (`Mod+Alt+N`), `new-folder` (`Mod+Shift+N`), `upload` (`Mod+U`), `refresh` (`Alt+R`; `Mod+R` and `F5` reload the inspected page in DevTools), `rename` (`F2`), `duplicate` (`Mod+D`), `delete` (`Delete` and `Mod+Backspace`), `download` (`Mod+S` when no editor has focus);
    - `save` (`Mod+S` in the editor), `discard` (`Mod+Shift+Z`), `format-json` (`Mod+Shift+F`), `select-all` (`Mod+A`), `copy-path` (`Mod+Shift+C` is DevTools', so use `Mod+Alt+C`), `folder-size` (`Mod+I`), `collapse-all` (`Mod+Shift+Left`), `expand` (`Right`), `collapse` (`Left`), `open` (`Enter`), `go-up` (`Backspace`), `settings` (`Mod+,`), `help` (`?`), `next-tab` and `prev-tab` (`Mod+Alt+Right` and `Mod+Alt+Left`), `zoom-in`, `zoom-out` and `rotate` (`+`, `-`, `R` in the image preview).

- [ ] **Step 1:** Write the failing tests:
  - `right-click a row opens a menu with Rename, Duplicate, Delete and their shortcut hints`.
  - `F2 starts rename`.
  - `? lists at least 20 shortcuts`: count `#help [role=row]` and expect at least 20.
  - `shortcut hints use the platform's modifier`: assert by injecting `navigator.platform` on page creation.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the registry, the menu and the overlay, and move the existing toolbar actions onto the registry.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: command registry with shortcuts, context menus and help`.

### Task 6: Duplicate, move, drag and drop, bulk delete and zip download

**Files:**
- Modify: `panel/actions.js`, `panel/tree.js`
- Create: `panel/zip.entry.js` (fflate, lazy). Add dep `fflate`.
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `copy`, `move` and `stat` (Task 2), `state.selection` (Task 4), and the commands (Task 5).
- Produces:
  - `zip.entry.js`: `export async function zipEntries(entries: AsyncIterable<{path, bytes}>) -> Blob`, which uses `fflate.Zip` streaming.
  - Bulk delete asks once, naming the count (`Delete 3 items?`), and reports per-item failures in `#status`.
  - Download rules:
    - one file downloads as it is;
    - anything else is a zip named `<folder or origin host>.zip`;
    - files are read in 512 KB chunks with progress above 5 MB.
  - Drop rules:
    - Files dropped from the computer onto a folder row, or onto empty space (the selected folder), are uploaded. Folders keep their structure, read through `DataTransferItem.webkitGetAsEntry()`. Existing names are skipped and listed in `#status`.
    - Rows dragged onto a folder row are moved there. A drop target is highlighted, and an invalid target (itself or its own child) shows a "not allowed" cursor.

- [ ] **Step 1:** Write the failing tests:
  - `duplicate makes "a copy.txt"`.
  - `drag a.txt onto folder y moves it`: use `locator.dragTo`.
  - `dragging a folder onto its own child is refused and nothing moves`.
  - `drop two files from the computer`: dispatch a `drop` with a `DataTransfer` built in the page. Both files appear, and a clashing name is reported as skipped.
  - `select 3 and Delete removes all after one confirm`.
  - `download of a selection is a zip containing the paths`: catch it with `page.waitForEvent('download')`, unzip in Node with `fflate.unzipSync`, and assert the entry names.
  - `zip bundle is not loaded until a zip is made`: there is no request for `zip` in `page.on('request')` before the download.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the actions above.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: duplicate, move, drag and drop, bulk delete and zip download`.

### Task 7: Folder sizes, storage details and settings

**Files:**
- Create: `panel/settings.js`
- Modify: `panel/detail.js`, `panel/actions.js`, `panel.html`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `dirSize` and `estimate` (Task 2).
- Produces:
  - `settings.js`: `getSettings() -> {jsonIndent: 2|4|'\t', sortKeys: boolean, folderSize: 'own'|'recursive', editorFontSize: number}` and `setSettings(partial)`.
    - The values are kept in `localStorage['opfs-inspector:settings']`.
    - Every read and write is wrapped in try/catch, falling back to the defaults `{2, false, 'own', 12}`.
    - `onSettingsChange(listener)`.
  - The folder Details tab:
    - A "Calculate size" button uses `settings.folderSize`, with a second button for the other mode.
    - It shows bytes, files and folders.
    - A Cancel button ignores the result. Use a run token, as 0.1.0's `detailRun` does.
  - The Storage details view opens from the footer. It shows usage and quota for the default storage and for each bucket, using `estimate`.
  - The Settings dialog is a `<dialog>` with labelled controls, opened by the gear button and `Mod+,`.

- [ ] **Step 1:** Write the failing tests:
  - `folder size own and recursive match the fixture` (same fixture as Task 2).
  - `settings persist across reload`.
  - `storage details lists each bucket` (Chromium).
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the above.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: folder sizes, storage details and settings`.

### Task 8: Code editor and JSON formatting

**Files:**
- Create: `panel/editor.entry.js`. Add deps `codemirror`, `@codemirror/lang-json`, `@codemirror/lang-javascript` (which covers TS), `@codemirror/lang-html`, `@codemirror/lang-css`, `@codemirror/lang-markdown` and `@codemirror/lang-sql`.
- Modify: `panel/detail.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `getSettings` and `onSettingsChange` (Task 7), and `save`, `discard` and `format-json` (Task 5).
- Produces:
  - `editor.entry.js`: `export function createEditor(parent, {text, language, fontSize, dark, onChange}) -> {getText(), setText(t), focus(), destroy()}`. The language comes from the extension: json, js/mjs/cjs/ts/tsx/jsx, html/htm, css, md/markdown, sql. Anything else is plain text.
  - `formatJson(text, {indent, sortKeys}) -> string`, in `panel/format.js`. It throws `SyntaxError` with the line and column (computed from the error position) for invalid JSON. `sortKeys` sorts object keys at every level and keeps array order.
  - 0.1.0's dirty guard keeps its meaning: `state.dirty` is set from `onChange`, and nothing redraws the card while it is dirty.

- [ ] **Step 1:** Write the failing tests:
  - `formatJson`, with `{"b":1,"a":[3,1]}`, indent 2 and `sortKeys: true`, returns `'{\n  "a": [\n    3,\n    1\n  ],\n  "b": 1\n}'`.
  - `invalid JSON shows the line and column in #status and leaves the text`.
  - `JSON file shows highlighted tokens`: `.cm-editor` is visible and a `span` uses a token class.
  - `editing marks dirty, and Save writes the file`: reuse 0.1.0's test with the new editor.
  - `editor bundle loads only when a text file opens`: there is no `editor` request before then.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the above. Replace the `<textarea>` with `createEditor`, loaded with dynamic `import('./editor.entry.js')`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: syntax-highlighting editor and JSON formatting`.

### Task 9: Image preview

**Files:**
- Create: `panel/image.js`
- Modify: `panel/detail.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces: `showImage(container, blob, name) -> {destroy()}`.
  - It uses `<img src=URL.createObjectURL(blob)>` and revokes the URL on `destroy`.
  - Controls: Fit, 100%, zoom in and zoom out (steps of 25%, from 10% to 800%), rotate 90° clockwise, and the pixel size from `naturalWidth` and `naturalHeight`.
  - Recognised types: png, jpg/jpeg, gif, webp, avif, svg, ico, by extension or by the magic bytes in the first chunk.
  - Files over 5 MB show the Download offer instead.

- [ ] **Step 1:** Write the failing tests:
  - `png shows its pixel size`, with a 3×2 PNG made by `OffscreenCanvas` in the page.
  - `rotate turns it 90 degrees`: the computed transform includes `rotate(90deg)`.
  - `svg with a script does not run it`: the SVG `<svg xmlns=... onload="window.top.__pwned=1"><script>window.top.__pwned=1</script></svg>` leaves `window.__pwned` undefined.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the above.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: image preview with zoom and rotate`.

### Task 10: Markdown preview

**Files:**
- Create: `panel/markdown.entry.js`. Add deps `marked` and `dompurify`.
- Modify: `panel/detail.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces:
  - `export function renderMarkdown(text) -> DocumentFragment`. It runs `DOMPurify.sanitize(marked.parse(text), {RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style','iframe','form','object','embed'], FORBID_ATTR: ['style']})`.
  - Links get `target=_blank rel=noopener noreferrer`, and only `http`, `https` and `mailto` links are kept.
  - Images inside Markdown are not loaded. Their `src` is removed, so there is no network request, and the alt text is shown.
  - `.md` files open on the Preview tab, and the Editor tab uses Task 8's editor.

- [ ] **Step 1:** Write the failing tests:
  - `headings and lists render`.
  - `hostile markdown is inert`. The input mixes `<script>`, `<img src=x onerror=...>`, `[x](javascript:...)` and `<iframe>`.
    - `window.__pwned` stays undefined.
    - There is no `script`, `iframe` or `on*` attribute in `#card-body`.
    - No link has an `href` starting with `javascript:`.
  - `markdown images make no request`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Implement the above.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit: `feat: markdown preview with sanitised output`.

### Task 11: Read-only SQLite viewer

**Files:**
- Create: `panel/sqlite.entry.js` (the worker entry, which bundles sql.js) and `panel/wal.js`. Add dep `sql.js`.
- Create: `panel/snapshot.js`
- Modify: `panel/detail.js`, `scripts/build.mjs` (copy `sql-wasm.wasm`)
- Test: `test/wal.test.mjs` (Node only) and `test/ui.test.mjs`

**Interfaces:**
- Consumes: `stat` and `read` (Task 2 and 0.1.0).
- Produces:
  - `wal.js`: `applyWal(db: Uint8Array, wal: Uint8Array) -> Uint8Array`. It follows the WAL format at sqlite.org/fileformat2.html#walformat:
    - The 32-byte header holds a magic of `0x377f0682` or `0x377f0683`, which sets the checksum byte order, plus the page size, salt-1, salt-2 and the header checksum.
    - Each frame is 24 bytes followed by one page. A frame is valid when its salts match the header and its running checksum matches.
    - Frames are applied up to the last valid frame whose "db size after commit" field is not 0. That field also sets the output length (`pages × pageSize`).
    - Finally it sets bytes 18 and 19 of the output to `1`, meaning not WAL.
    - When the WAL is empty or invalid, it returns the db with bytes 18 and 19 set to `1`.
  - `snapshot.js`: `takeSnapshot(area, path, {onProgress}) -> {db: Uint8Array, takenAt: number, walApplied: boolean}`.
    - It reads the file and `<path>-wal` (when `stat` finds one) in 512 KB chunks.
    - Every `read` reply must report the same `size` and `lastModified` as the `stat` taken before reading. Otherwise it retries, up to 3 times, then throws `"The database kept changing while it was copied. Try Reload snapshot."`.
    - Over 200 MB, it throws `"Too large to open here (over 200 MB). Download it instead."`.
  - Pool-file hint: when the folder holds names like `.opaque` or 16-character random file names with no SQLite header, Details says "This looks like a SQLite pool file (opfs-sahpool or AccessHandlePoolVFS), which this viewer cannot read."
  - Worker protocol (`sqlite.entry.js`). Messages in: `{id, type:'open', bytes}`, `{id, type:'tables'}`, `{id, type:'rows', table, offset, limit:100}`, `{id, type:'query', sql}`. Replies are `{id, ok, value | error}`.
    - On `open`, the worker runs `PRAGMA query_only = ON`.
    - `query` runs only the first statement. A second statement is an error: "Run one statement at a time."
    - The result shape is `{columns: string[], rows: any[][], truncated: boolean}`, with at most 1,000 rows.
  - The UI:
    - The Table tab has a list of tables and views, a grid with column names and types (`PRAGMA table_info`), and Prev and Next buttons with a count.
    - The Query tab has a SQL editor (Task 8, language sql) and a Run button (`Mod+Enter`).
    - The header shows "Snapshot taken <time>" and a Reload snapshot button.

- [ ] **Step 1:** Write the failing tests in `test/wal.test.mjs`. Fixtures are made in the test with Node's `node:sqlite` module: create a WAL-mode db, insert rows, then copy `x.db` and `x.db-wal` without a checkpoint.
  - `applyWal brings in committed rows`: open `applyWal(db, wal)` with sql.js and expect `select count(*)` to give the inserted count.
  - `an uncommitted tail is ignored`: cut the WAL mid-frame and expect the count of the last commit.
  - `a WAL with wrong salts is ignored`.
  - `bytes 18 and 19 are 1`.
- [ ] **Step 2:** Run `node --test test/wal.test.mjs`. Expected: fail.
- [ ] **Step 3:** Implement `applyWal`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Write the failing UI tests. Each one creates `app.db` in OPFS by writing the bytes of a db built in Node.
  - `tables list and first page of rows`.
  - `Next shows rows 101 to 200`.
  - `query select works, and a write is refused`: `delete from t` gives an error matching `/readonly|query_only/`, and the row count after Reload snapshot is unchanged.
  - `a held database still opens`: a worker holds a `readwrite` sync access handle on it.
  - `a database that changes during copy`: stub `transport` so the second `read` reply has a new `lastModified` on every try. The card shows "kept changing".
  - `sqlite bundle and wasm load only on first open`.
- [ ] **Step 6:** Run `ENGINES=chromium,firefox node --test test/ui.test.mjs`. Expected: fail.
- [ ] **Step 7:** Implement the snapshot, the worker and the UI.
- [ ] **Step 8:** Run it. Expected: pass.
- [ ] **Step 9:** Commit: `feat: read-only SQLite viewer on a snapshot`.

### Task 12: Real extension check, docs and store assets for 0.2.0

**Files:**
- Modify:
  - `test/extension.test.mjs`: add one check each for the editor, the SQLite viewer and drag-move, in the real extension in Chromium and Edge.
  - `README.md`: features, the pool-layout limit, and screenshots.
  - `PRIVACY.md`: "It keeps only your panel settings, in the extension's own storage."
  - `store/listing.md`: the description, a permission note that WebAssembly is used only for the SQLite viewer, with no remote code.
  - `scripts/screenshots.mjs`: new shots for the editor, a SQLite table, an image, the picker and dark mode.
  - `PUBLISHING.md`: raise the version step.
- Test: `npm test`, `npm run lint:firefox`, `npm run package`

- [ ] **Step 1:** Add the extension checks and run `ENGINES=chromium node --test test/extension.test.mjs`, then the full `npm test` with Edge. Expected: pass.
- [ ] **Step 2:** Run `npm run lint:firefox`. Expected: 0 errors. The only warning is the known `service_worker` one.
- [ ] **Step 3:** Run `node scripts/screenshots.mjs` and look at each image.
- [ ] **Step 4:** Run `npm run package`. Check that the zip has `build/`, `build/sql-wasm.wasm` and `build/THIRD_PARTY.txt`, and no `node_modules`. Its size is reported in the hand-over.
- [ ] **Step 5:** Update the docs listed above.
- [ ] **Step 6:** Commit: `docs: 0.2.0 readme, privacy, store listing and screenshots`.
