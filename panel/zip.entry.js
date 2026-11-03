// Builds a zip. Loaded only when one is made.
import { Zip, ZipPassThrough } from 'fflate';

// entries: async iterable of { path, bytes }. A path that ends in "/" is a folder.
// ponytail: stored, not compressed, so big files zip fast; use ZipDeflate if size matters more.
export async function zipEntries(entries) {
  const parts = [];
  let failure = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else parts.push(chunk);
  });
  for await (const { path, bytes } of entries) {
    const file = new ZipPassThrough(path);
    zip.add(file);
    file.push(bytes, true);
    if (failure) throw failure;
  }
  zip.end();
  if (failure) throw failure;
  return new Blob(parts, { type: 'application/zip' });
}
