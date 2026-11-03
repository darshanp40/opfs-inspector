// File operations on the origin private file system of the page this runs in.
// Every call looks its path up again from the root and keeps no handles, so a
// handle from before a site-data deletion is never reused.
(() => {
  const DEFAULT_AREA = { kind: 'default' };
  const CHUNK = 512 * 1024;

  // Turns DOM errors into messages a person can act on.
  function explain(error) {
    const name = error && error.name;
    const text = String((error && error.message) || error);
    if (name === 'NoModificationAllowedError') {
      return 'The file is in use, for example by a database that has it open. Close it in the page, then try again.';
    }
    if (name === 'InvalidStateError' && text.includes('state had changed')) {
      return 'The browser lost track of this site\'s files, which happens after site data was deleted while the page was open. Restart the browser. See https://issues.chromium.org/issues/575150688';
    }
    if (name === 'NotFoundError') return 'It no longer exists. Refresh to see the current files.';
    if (name === 'TypeMismatchError') return 'A file and a folder have the same name here.';
    if (name === 'InvalidModificationError') return 'The folder is not empty.';
    if (name === 'QuotaExceededError') return 'The site has no storage space left.';
    if (name === 'SecurityError') return 'This page cannot use the origin private file system, for example because it is not a secure context.';
    return `${name || 'Error'}: ${text}`;
  }

  function splitPath(path) {
    return String(path || '').split('/').filter((part) => part && part !== '.');
  }

  function checkName(name) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new TypeError(`"${name}" is not a valid name.`);
    }
  }

  async function bucketNames() {
    if (!navigator.storageBuckets) return [];
    return (await navigator.storageBuckets.keys()).sort();
  }

  async function root(area = DEFAULT_AREA) {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      throw new Error('This browser has no origin private file system.');
    }
    if (area.kind === 'bucket') {
      // open() would create a missing bucket, so only open one that exists.
      if (!(await bucketNames()).includes(area.name)) {
        throw Object.assign(new Error(`The bucket "${area.name}" no longer exists.`), { name: 'NotFoundError' });
      }
      const bucket = await navigator.storageBuckets.open(area.name);
      return bucket.getDirectory();
    }
    return navigator.storage.getDirectory();
  }

  async function dirAt(area, parts, create = false) {
    let dir = await root(area);
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  }

  async function parentAndName(area, path) {
    const parts = splitPath(path);
    const name = parts.pop();
    if (!name) throw new TypeError('The root cannot be changed.');
    return { parent: await dirAt(area, parts), name };
  }

  async function fileAt(area, path, create = false) {
    const { parent, name } = await parentAndName(area, path);
    return parent.getFileHandle(name, { create });
  }

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function canWrite() {
    return typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
  }

  async function writeAt(handle, data, position, truncate) {
    if (!canWrite()) {
      throw new Error('This browser cannot change files from a page. Safari supports it from version 26.');
    }
    const writable = await handle.createWritable({ keepExistingData: !truncate });
    try {
      if (position > 0) await writable.seek(position);
      await writable.write(data);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async function copyInto(source, targetDir, name) {
    if (source.kind === 'file') {
      const target = await targetDir.getFileHandle(name, { create: true });
      await writeAt(target, await source.getFile(), 0, true);
      return;
    }
    const dir = await targetDir.getDirectoryHandle(name, { create: true });
    for await (const child of source.values()) await copyInto(child, dir, child.name);
  }

  async function exists(dir, name) {
    for await (const key of dir.keys()) if (key === name) return true;
    return false;
  }

  // The file or folder with this name, whichever it is.
  async function entryAt(dir, name) {
    try {
      return await dir.getFileHandle(name);
    } catch (error) {
      if (error.name !== 'TypeMismatchError') throw error;
      return dir.getDirectoryHandle(name);
    }
  }

  function tooDeep(path, toDir) {
    const from = splitPath(path).join('/');
    const to = splitPath(toDir).join('/');
    return to === from || to.startsWith(`${from}/`);
  }

  const joinPath = (dir, name) => [...splitPath(dir), name].join('/');

  async function sizeOf(dir, recursive, total) {
    for await (const child of dir.values()) {
      if (child.kind === 'file') {
        total.bytes += (await child.getFile()).size;
        total.files++;
      } else {
        total.folders++;
        if (recursive) await sizeOf(child, true, total);
      }
    }
    return total;
  }

  const ops = {
    async areas() {
      const areas = [{ id: 'default', label: 'Default storage', area: DEFAULT_AREA }];
      for (const name of await bucketNames()) {
        areas.push({ id: `bucket:${name}`, label: `Bucket: ${name}`, area: { kind: 'bucket', name } });
      }
      return {
        areas,
        origin: location.origin,
        canWrite: canWrite(),
        hasBuckets: Boolean(navigator.storageBuckets),
      };
    },

    // One level only. Sizes come from this folder's files, nothing deeper.
    async list({ area, path }) {
      const dir = await dirAt(area, splitPath(path));
      const handles = [];
      for await (const handle of dir.values()) handles.push(handle);
      // Reading sizes in parallel keeps a 10,000-file folder fast.
      const entries = await Promise.all(handles.map(async (handle) => {
        const entry = { name: handle.name, kind: handle.kind };
        if (handle.kind === 'file') {
          try {
            const file = await handle.getFile();
            entry.size = file.size;
            entry.lastModified = file.lastModified;
          } catch (error) {
            entry.error = explain(error);
          }
        }
        return entry;
      }));
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
      return entries;
    },

    async read({ area, path, offset = 0, length = CHUNK }) {
      const file = await (await fileAt(area, path)).getFile();
      const end = Math.min(file.size, offset + length);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      return { size: file.size, lastModified: file.lastModified, offset, data: toBase64(bytes) };
    },

    async writeText({ area, path, text }) {
      await writeAt(await fileAt(area, path), text, 0, true);
    },

    // Writes one chunk. The first chunk replaces the file.
    async writeChunk({ area, path, data, offset }) {
      await writeAt(await fileAt(area, path, offset === 0), fromBase64(data), offset, offset === 0);
    },

    async createFile({ area, path }) {
      const { parent, name } = await parentAndName(area, path);
      checkName(name);
      if (await exists(parent, name)) throw new Error(`"${name}" already exists.`);
      await parent.getFileHandle(name, { create: true });
    },

    async createFolder({ area, path }) {
      const { parent, name } = await parentAndName(area, path);
      checkName(name);
      if (await exists(parent, name)) throw new Error(`"${name}" already exists.`);
      await parent.getDirectoryHandle(name, { create: true });
    },

    async rename({ area, path, newName }) {
      checkName(newName);
      const { parent, name } = await parentAndName(area, path);
      if (newName === name) return;
      if (await exists(parent, newName)) throw new Error(`"${newName}" already exists.`);
      const handle = await entryAt(parent, name);
      if (typeof handle.move === 'function') {
        try {
          await handle.move(newName);
          return;
        } catch (error) {
          if (error.name !== 'NotSupportedError' && error.name !== 'TypeError') throw error;
        }
      }
      // No move(): copy, then delete the original.
      await copyInto(handle, parent, newName);
      await parent.removeEntry(name, { recursive: true });
    },

    async copy({ area, path, toDir, newName }) {
      const { parent, name } = await parentAndName(area, path);
      const source = await entryAt(parent, name);
      if (source.kind === 'directory' && tooDeep(path, toDir)) {
        throw new Error('A folder cannot be copied into itself.');
      }
      const target = await dirAt(area, splitPath(toDir));
      let finalName = newName;
      if (finalName) {
        checkName(finalName);
        if (await exists(target, finalName)) throw new Error(`"${finalName}" already exists.`);
      } else {
        // "a.txt" -> "a copy.txt" -> "a copy 2.txt". A folder has no extension.
        const dot = source.kind === 'file' ? name.lastIndexOf('.') : -1;
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        finalName = `${stem} copy${ext}`;
        for (let n = 2; await exists(target, finalName); n++) finalName = `${stem} copy ${n}${ext}`;
      }
      await copyInto(source, target, finalName);
      return { path: joinPath(toDir, finalName) };
    },

    async move({ area, path, toDir }) {
      const { parent, name } = await parentAndName(area, path);
      if (tooDeep(path, toDir)) throw new Error('A folder cannot be moved into itself.');
      const target = await dirAt(area, splitPath(toDir));
      if (await exists(target, name)) {
        throw new Error(`"${name}" already exists in ${splitPath(toDir).join('/') || '/'}.`);
      }
      const handle = await entryAt(parent, name);
      if (typeof handle.move === 'function') {
        try {
          await handle.move(target);
          return { path: joinPath(toDir, name) };
        } catch (error) {
          if (error.name !== 'NotSupportedError' && error.name !== 'TypeError') throw error;
        }
      }
      // No move(): copy, then delete the original.
      await copyInto(handle, target, name);
      await parent.removeEntry(name, { recursive: true });
      return { path: joinPath(toDir, name) };
    },

    // Folders count the ones directly inside, or all of them when recursive.
    async dirSize({ area, path, recursive }) {
      const dir = await dirAt(area, splitPath(path));
      return sizeOf(dir, Boolean(recursive), { bytes: 0, files: 0, folders: 0 });
    },

    async estimate({ area = DEFAULT_AREA }) {
      let storage = navigator.storage;
      if (area.kind === 'bucket') {
        // Same rule as root(): only open a bucket that exists.
        if (!(await bucketNames()).includes(area.name)) {
          throw Object.assign(new Error(`The bucket "${area.name}" no longer exists.`), { name: 'NotFoundError' });
        }
        storage = await navigator.storageBuckets.open(area.name);
      }
      if (!storage || !storage.estimate) return { usage: null, quota: null };
      const { usage, quota } = await storage.estimate();
      return { usage, quota };
    },

    async stat({ area, path }) {
      const { parent, name } = await parentAndName(area, path);
      const handle = await entryAt(parent, name);
      if (handle.kind === 'directory') return { kind: 'directory' };
      const file = await handle.getFile();
      return { kind: 'file', size: file.size, lastModified: file.lastModified };
    },

    async remove({ area, path }) {
      const { parent, name } = await parentAndName(area, path);
      await parent.removeEntry(name, { recursive: true });
    },
  };

  async function run(op, args) {
    if (!Object.hasOwn(ops, op)) return { ok: false, error: `Unknown operation "${op}".` };
    try {
      return { ok: true, value: await ops[op](args || {}) };
    } catch (error) {
      return { ok: false, error: explain(error) };
    }
  }

  globalThis.__opfsInspector = { run, explain, CHUNK };
})();
