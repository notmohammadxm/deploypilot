import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$/i;
const WINDOWS_INVALID = /[<>:"|?*\\u0000-\\u001f]/;

export function resolveZipEntry(rootDirectory, entry) {
  const root = path.resolve(rootDirectory);
  const fileName = entry?.fileName;
  if (typeof fileName !== 'string' || !fileName || fileName.includes('\\\\')) {
    throw new Error('ZIP contains an invalid entry name.');
  }
  const validationError = yauzl.validateFileName(fileName);
  if (validationError) throw new Error('ZIP contains an unsafe path: ' + validationError);

  const isDirectory = fileName.endsWith('/');
  const relativeName = isDirectory ? fileName.slice(0, -1) : fileName;
  const parts = relativeName.split('/');
  if (!relativeName || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('ZIP contains an unsafe relative path.');
  }
  if (parts.some((part) => WINDOWS_INVALID.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))) {
    throw new Error('ZIP contains a path that is not safe on Windows.');
  }

  const attributes = Number(entry.externalFileAttributes) >>> 0;
  const unixMode = (attributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000 || (attributes & 0x400) !== 0) {
    throw new Error('ZIP symbolic links and reparse points are not allowed.');
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error('ZIP contains an unsupported special file.');
  }
  if (isDirectory && fileType === 0o100000) {
    throw new Error('ZIP directory entry has conflicting file attributes.');
  }
  if (!isDirectory && fileType === 0o040000) {
    throw new Error('ZIP file entry has conflicting directory attributes.');
  }

  const destination = path.resolve(root, ...parts);
  if (destination === root || !destination.startsWith(root + path.sep)) {
    throw new Error('ZIP entry escapes the extraction directory.');
  }
  return { destination, isDirectory };
}

export async function extractZipSafely(zipPath, destinationDirectory) {
  const root = path.resolve(destinationDirectory);
  await fs.mkdir(root, { recursive: true });
  const zip = await yauzl.openPromise(zipPath, {
    autoClose: false,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true
  });
  try {
    for await (const entry of zip.eachEntry()) {
      const { destination, isDirectory } = resolveZipEntry(root, entry);
      if (isDirectory) {
        await fs.mkdir(destination, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const readStream = await zip.openReadStreamPromise(entry);
      await pipeline(readStream, createWriteStream(destination, { flags: 'wx' }));
    }
  } finally {
    zip.close();
  }
  return root;
}
