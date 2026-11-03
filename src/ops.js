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
      const entries = [];
      for await (const handle of dir.values()) {
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
        entries.push(entry);
      }
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
      let handle;
      try {
        handle = await parent.getFileHandle(name);
      } catch (error) {
        if (error.name !== 'TypeMismatchError') throw error;
        handle = await parent.getDirectoryHandle(name);
      }
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
