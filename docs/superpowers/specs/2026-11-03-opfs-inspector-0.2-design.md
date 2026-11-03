# OPFS Inspector 0.2.0 design

## Why

OPFS Inspector 0.1.0 is in review at the Chrome Web Store. It is a plain, working explorer. The owner wants 0.2.0 to be the richest and best-looking OPFS explorer in the Chrome and Edge stores, for web developers whose apps keep files and SQLite databases in OPFS and Storage Buckets.

Two things set it apart from the other explorers:

- Storage Buckets, which 0.1.0 already has.
- A read-only SQLite viewer: browse tables and run queries on a snapshot of a database file. No other OPFS explorer in the stores has one.

0.2.0 ships as an update to 0.1.0. 0.1.0 is not held back.

## Goals

Everything below is in scope for 0.2.0.

**Look (owner's pick, "modern app" mockup B).**
- Roomy and rounded, with icon buttons that have text tooltips.
- A path bar ("Default / settings / config.json") whose parts can be clicked.
- The storage picker sits at the top right as a pill dropdown: default storage plus each bucket.
- The tree is on the left. The selected row is filled with the accent colour.
- The open item is shown on a card on the right, with tabs that depend on its type, for example Editor, Preview, Table, Details.
- A footer shows the storage used, with a meter.
- Follows the DevTools light or dark theme (`devtools.panels.themeName`, falling back to `prefers-color-scheme`), and Windows high-contrast mode (`forced-colors`).
- The mockup is at `.superpowers/brainstorm/*/content/layout.html`. Only option B (the middle card) applies; A and C were the options not chosen. Where the mockup and this text differ, the text wins.

**Features.**
1. **File-type icons** in the tree: folder, text, JSON, code, Markdown, image, SQLite database, and other binary.
2. **Code editor** with syntax highlighting for at least JSON, JavaScript, TypeScript, HTML, CSS, Markdown and SQL. It keeps 0.1.0's rules: UTF-8 only, Save and Discard, and you cannot leave a file with unsaved changes.
3. **Folder sizes on demand**: a folder's own files, or everything inside it. Computed only when asked, and can be cancelled.
4. **JSON formatting** with one click, using the indent and key-sorting choices from Settings. Formatting changes the editor text only; the file changes when you Save.
5. **Image preview** up to 5 MB: zoom, rotate, fit to card, and the image's pixel size. PNG, JPEG, GIF, WebP, AVIF, SVG and ICO.
6. **Markdown**: a Preview tab and an Editor tab.
7. **Selecting several items**: Ctrl or Cmd+click, Shift+click and Ctrl or Cmd+A. Bulk delete and bulk download work on the selection.
8. **Drag and drop**: drop files and folders from the computer to upload them, and drag one or more items inside the tree to move them.
9. **Full create, rename, duplicate, move and delete** for files and folders.
10. **Download**: single files as they are. Several items, or a folder, as one zip file.
11. **Storage stats**: usage and quota for the site and for each bucket, in the footer and in a Storage details view.
12. **Settings panel**: JSON indent (2, 4 or tab), sort JSON keys, folder-size mode (this folder only, or everything inside), and text editor font size. Stored with `localStorage` in the extension's own pages. No new permission.
13. **Keyboard shortcuts**: at least 20, shown in tooltips and in right-click menus, with Cmd on macOS and Ctrl elsewhere. A "?" key shows them all.
14. **Right-click menus** on tree rows and empty space, with the same actions as the toolbar.
15. **Accessibility**: WCAG 2.1 AA. The tree follows the ARIA tree pattern. Every action can be done by keyboard. Focus is always visible. Changes are announced in a live region. Contrast meets AA in both themes and in high-contrast mode.
16. **SQLite viewer** for files that start with the SQLite header:
    - A Table tab lists the tables and views. Choosing one shows its rows in pages of 100, with column names and types.
    - A Query tab runs one SQL statement and shows the result. It is read-only: the database is opened with `SQLITE_OPEN_READONLY`, or with `PRAGMA query_only = ON`.
    - It reads a snapshot. The panel copies the file's bytes, and the `-wal` file next to it when one exists, then opens the copy in SQLite in the panel. The live file is never opened by the viewer, so the app's own database cannot be damaged. The card says when the snapshot was taken and has a "Reload snapshot" button.
    - Reading works while the app has the database open. Checked on 2026-11-03: with a worker holding a sync access handle in `readwrite` or `readwrite-unsafe` mode, `getFile()` still returned the current bytes, in Chromium 141 and Firefox 142. Only writes are refused while a file is held.
    - A file that changes during the copy gives a torn snapshot. The builder detects this (for example, size and modified time before and after) and retries a few times.
    - *Builder's call:* SQLite's in-memory loading does not replay a `-wal` file. So the copy is written to a temporary folder in the extension's own OPFS, opened there in a worker in the panel, and deleted when the card closes. Leftovers are swept when the panel opens. The data never leaves the device, but `PRIVACY.md` is reworded so it no longer says the extension has no storage of its own.
    - *Builder's call:* 0.2.0 reads plain database files, meaning files that start with the SQLite header. Pool layouts (`opfs-sahpool`, wa-sqlite's AccessHandlePoolVFS) and databases kept in IndexedDB are not read. The README says so, and the card explains it when a file looks like a pool file.
    - Databases written by VFSs that keep extra files (for example wa-sqlite's write-ahead files) may show slightly old data. The card says so when it finds files like these next to the database.

## Non-goals

- Editing SQLite rows or running writing SQL.
- Watching files for changes. Refresh stays manual.
- New browsers or platforms beyond 0.1.0's Chrome, Edge, Firefox and Safari.
- Any network access, analytics or remote code.

## Anti-goals: what would make this a failure even if it works

- The inspected page gets slower or does more work. Nothing may run in the page until the panel is opened for it, as in 0.1.0.
- The panel feels slow to open. Heavy parts load only when first needed.
- The SQLite viewer, or any feature, damages or locks a live app's database.
- A site's own file content can run code in the extension. For example, Markdown or SVG from a site must never execute script.
- Removing 0.1.0's safety rules: no handles kept between actions, a bucket is never created by opening it, and errors are explained in plain words.

## Constraints

- **Manifest V3**, one codebase for Chrome, Edge, Firefox (128 and later) and Safari, as in 0.1.0.
- **Page weight.** Code injected into the page stays small and only does file operations (`src/ops.js`). All new UI, parsing, zip, image and SQLite work happens in the panel.
- **Panel weight.** Allowed to grow. The code editor, Markdown renderer, zip library and SQLite engine load on first use, not when the panel opens. Target: the panel shows the tree within 300 ms of opening on a normal laptop with a 1,000-file folder.
- **No remote code.** Every library is bundled into the package. The SQLite engine is WebAssembly, so the manifest adds `"content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"}`. Store answers stay "no remote code". The store's permission reasons in `store/listing.md` are updated if anything changes.
- **No new permissions** beyond `scripting` and host access, unless a feature truly needs one. A new one would show users a new warning.
- **Untrusted content.** Everything read from the site is untrusted.
  - Markdown is rendered to HTML and then sanitised (no scripts, no event handlers, no `javascript:` links, no iframes) before it is shown.
  - Images, including SVG, are shown through `<img>` from a blob URL, never inline.
  - The extension's CSP is a second line of defence, not the only one.
- **Large files.** Moving bytes from the page to the panel goes through messages in chunks, as in 0.1.0. Limits: editor 2 MB, image preview 5 MB, SQLite snapshot 200 MB. Above a limit, offer Download instead. Show progress for anything over 5 MB.
- **Moves.** Use `FileSystemHandle.move()` where it exists and works across folders, with 0.1.0's copy-then-delete fallback. Moving a folder into itself is refused.
- **Licences.** Only MIT, BSD, Apache-2.0 or public-domain libraries. Their notices ship in the package.
- **Tests.** Every feature is covered by the Playwright suites, in the same style as 0.1.0: `ops.test.mjs` for page operations, `ui.test.mjs` for the panel, and `extension.test.mjs` for the real extension in Chrome and Edge. `npm run lint:firefox` stays at zero errors.
- **Commits** are authored as Darshan Pawar with the no-reply address and mention no tool or assistant.

## Decided by the owner

- Look B, the modern app.
- The page stays light. The panel can be bigger.
- The whole feature list above, plus the SQLite viewer.
- The SQLite viewer is read-only.
- Ship 0.1.0 now. 0.2.0 is a later update.

## The builder's calls (made here, open to the owner's review)

- **A build step** (esbuild) bundles the panel and its libraries. Source stays readable. The zip contains the built files. `src/ops.js` and `src/agent.js` stay hand-written, with no build step, so the page part stays small and easy to review.
- **Libraries**:
  - CodeMirror 6 for the editor.
  - The official SQLite WebAssembly build (`@sqlite.org/sqlite-wasm`) for the viewer.
  - A small Markdown parser plus DOMPurify.
  - fflate for zips.
  - The builder may swap any of these for something smaller that meets the same need.
- **Downloads** of several items are zipped. A single file downloads as it is.
- **Settings** are kept in the extension's own `localStorage`, so no `storage` permission is needed.
- **Version**: 0.2.0. Firefox and Safari get the same features where their APIs allow. Where one doesn't, the control is hidden or explains why, as 0.1.0 does for buckets.

## Left to the builder

- The exact shortcut keys, as long as they don't clash with DevTools' own shortcuts.
- Icon artwork, as long as each type is clear in both themes.
- Code layout inside the panel, and how features are split into files.
- Whether the tree needs a virtual list. It must stay smooth with 10,000 items in one folder.
- Store screenshots and README updates for 0.2.0.
