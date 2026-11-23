import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateUploadPath } from './rules.js';
import { isWithinLocal } from './path-utils.js';

export async function scanLocalProject(root, rules = {}) {
  const base = path.resolve(root);
  const files = [];
  const skipped = [];
  async function walk(directory, relative = '') {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      const rel = relative ? relative + '/' + item.name : item.name;
      if (!isWithinLocal(base, fullPath)) throw new Error('Scanner encountered a path outside the project folder.');
      if (item.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'Symbolic links are not followed' });
        continue;
      }
      const isDirectory = item.isDirectory();
      const decision = evaluateUploadPath(rel, rules, isDirectory);
      if (decision.action !== 'include') {
        skipped.push({ path: rel, reason: decision.reason });
        continue;
      }
      if (isDirectory) await walk(fullPath, rel);
      else if (item.isFile()) {
        const info = await fs.stat(fullPath);
        files.push({ path: rel, localPath: fullPath, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(base);
  return { files, skipped };
}
