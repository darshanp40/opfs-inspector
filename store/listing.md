# Store listing

Copy these into the Chrome Web Store and Edge Add-ons forms.

**Name:** OPFS Inspector

**Summary (up to 132 characters):**
Browse and edit a site's origin private file system, including Storage Buckets, from the developer tools.

**Category:** Developer Tools

**Language:** English

**Description:**

OPFS Inspector adds a tab to the developer tools. It shows the origin private file system of the page you are inspecting, including every Storage Bucket in Chrome and Edge.

New in 0.2.0:

- A clean new look, with file type icons, a path bar and storage use.
- A code editor with syntax colours, and Format JSON.
- Image and Markdown previews.
- A read-only SQLite viewer. See tables, page through rows and run queries on a copy of the database. It never changes the site's files.
- Drag to move, drop files to upload, duplicate, and download several items as a zip.
- Folder sizes, storage details for each bucket, and settings.
- Keyboard shortcuts and right-click menus. Press ? to see them all.

It also lets you:

- Pick the default storage or any Storage Bucket of the site.
- Create, rename, delete, upload and download files and folders.
- See clear messages when a database holds a file open.

It stays light. Nothing runs in a page until you open the tab, nothing refreshes by itself, and no file handles are kept between actions.

The SQLite viewer reads plain database files. It does not read pool layouts (opfs-sahpool, AccessHandlePoolVFS) or databases kept in IndexedDB.

Open source: https://github.com/darshanp40/opfs-inspector

**Single purpose (Chrome):**
Lets developers view and edit the origin private file system (OPFS) and Storage Buckets of the page they are inspecting in the developer tools.

**Permission reasons:**
- `scripting`: adds a small listener to the inspected page, only when the OPFS Inspector tab is opened for it, so the panel can read and change that page's OPFS files.
- Host permission (`<all_urls>`): the tab can be opened on any site, and OPFS can only be read from inside that site's own page.

- WebAssembly (`'wasm-unsafe-eval'` in the content security policy): used only by the SQLite viewer, to run the SQLite engine that is in the package. No remote code is loaded.

**Remote code:** No. All code is in the package, including the SQLite engine.

**Data use:** collects no user data. It keeps only the panel settings, in the extension's own storage. Tick none of the data types, and confirm the three certifications (no selling, no unrelated use, no credit checks).

**Privacy policy URL:** https://github.com/darshanp40/opfs-inspector/blob/main/PRIVACY.md

**Homepage / support URL:** https://github.com/darshanp40/opfs-inspector

**Images:**
- Icon: `icons/icon-128.png`
- Screenshots (1280×800): `docs/editor.png`, `docs/sqlite.png`, `docs/image.png`, `docs/picker.png`, `docs/dark.png` (RGB, no alpha)
- Small promo tile (Chrome, 440×280): `store/promo-440x280.png`
- Logo (Edge, 300×300): `store/logo-300x300.png`

**Package:** `dist/opfs-inspector-0.2.0.zip` from `npm run package`.
