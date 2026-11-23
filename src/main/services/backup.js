import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import extract from 'extract-zip';
import { once } from 'node:events';
import { evaluateBackupPath } from './rules.js';
import { remoteJoin, assertSafeRemotePath } from './path-utils.js';
import { selectExpiredBackups } from './retention.js';
import { backupDirectory } from './profileStore.js';

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
}

function safeLocal(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error('Unsafe path returned by the server.');
  const result = path.resolve(root, ...normalized.split('/'));
  if (result !== path.resolve(root) && !result.startsWith(path.resolve(root) + path.sep)) throw new Error('Backup path escaped its temporary directory.');
  return result;
}

async function downloadRemoteTree(connection, remoteRoot, localRoot, rules, signal, onProgress) {
  const files = [];
  async function walk(remoteDir, relative = '') {
    if (signal?.aborted) throw new Error('Deployment cancelled.');
    const entries = await connection.list(remoteDir);
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      const decision = evaluateBackupPath(rel, rules, entry.isDirectory);
      if (decision.action !== 'include') continue;
      const remote = remoteJoin(remoteRoot, rel);
      if (entry.isDirectory) {
        await fs.mkdir(safeLocal(localRoot, rel), { recursive: true });
        await walk(remote, rel);
      } else if (entry.isFile) {
        const destination = safeLocal(localRoot, rel);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await connection.download(remote, destination);
        files.push({ path: rel, size: entry.size || 0, modifiedAt: entry.modifiedAt || null });
        onProgress?.({ file: rel, completed: files.length });
      }
    }
  }
  await walk(assertSafeRemotePath(remoteRoot));
  return files;
}

async function zipDirectory(sourceDir, zipPath) {
  const output = await fs.open(zipPath, 'w');
  await output.close();
  const stream = (await import('node:fs')).createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (error) => { if (error.code !== 'ENOENT') archive.emit('error', error); });
  archive.on('error', (error) => stream.destroy(error));
  archive.pipe(stream);
  archive.directory(sourceDir, false);
  const closed = once(stream, 'close');
  await archive.finalize();
  await closed;
}

export async function createBackup({ connection, profile, target, onProgress, signal }) {
  if (!profile.options?.backup) return null;
  const remoteRoot = assertSafeRemotePath(target.remotePath);
  const outputRoot = backupDirectory(profile.name, target.name, profile.folders.backupFolder);
  await fs.mkdir(outputRoot, { recursive: true });
  const id = stamp();
  const zipPath = path.join(outputRoot, id + '.zip');
  const manifestPath = path.join(outputRoot, id + '.manifest.json');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deploypilot-backup-'));
  const contentRoot = path.join(tempRoot, 'remote');
  await fs.mkdir(contentRoot, { recursive: true });
  try {
    const rootStat = await connection.stat(remoteRoot);
    if (rootStat && !rootStat.isDirectory) throw new Error('The backup target path exists but is not a directory.');
    const files = rootStat
      ? await downloadRemoteTree(connection, remoteRoot, contentRoot, profile.rules, signal, onProgress)
      : [];
    const manifest = {
      version: 1,
      profileId: profile.id,
      profileName: profile.name,
      targetId: target.id,
      targetName: target.name,
      remotePath: remoteRoot,
      createdAt: new Date().toISOString(),
      files,
      fileCount: files.length,
      sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await zipDirectory(contentRoot, zipPath);
    const verifyDir = path.join(tempRoot, 'verify');
    await extract(zipPath, { dir: verifyDir });
    const verified = await fs.readdir(verifyDir);
    const backup = { id, path: zipPath, manifestPath, createdAt: manifest.createdAt, fileCount: files.length, targetId: target.id, targetName: target.name, remotePath: remoteRoot };
    const existing = (await listBackupsForDirectory(outputRoot)).filter((row) => row.path !== zipPath);
    const expired = selectExpiredBackups([backup, ...existing], profile.options?.retention ?? 10);
    for (const item of expired) {
      await fs.rm(item.path, { force: true });
      await fs.rm(item.manifestPath, { force: true });
    }
    return { ...backup, verified: Array.isArray(verified) };
  } catch (error) {
    await fs.rm(zipPath, { force: true }).catch(() => { /* Cleanup is best-effort after the original backup error. */ });
    await fs.rm(manifestPath, { force: true }).catch(() => { /* Cleanup is best-effort after the original backup error. */ });
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { /* Cleanup is best-effort after the original backup error. */ });
  }
}

async function listBackupsForDirectory(directory) {
  let names = [];
  try { names = await fs.readdir(directory); } catch { return []; }
  const rows = [];
  for (const name of names.filter((entry) => entry.endsWith('.zip'))) {
    const zipPath = path.join(directory, name);
    const manifestPath = path.join(directory, name.slice(0, -4) + '.manifest.json');
    let manifest = {};
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { /* Missing or malformed sidecar metadata is non-fatal while listing backups. */ }
    const stat = await fs.stat(zipPath).catch(() => null);
    rows.push({
      id: name.slice(0, -4),
      path: zipPath,
      manifestPath,
      createdAt: manifest.createdAt || stat?.mtime?.toISOString() || '',
      fileCount: manifest.fileCount || 0,
      targetId: manifest.targetId || '',
      targetName: manifest.targetName || path.basename(directory),
      remotePath: manifest.remotePath || ''
    });
  }
  return rows;
}

export async function listBackups(profile) {
  const root = backupDirectory(profile.name, '', profile.folders.backupFolder);
  const targetRoot = path.dirname(root);
  let targetDirs = [];
  try { targetDirs = await fs.readdir(targetRoot, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const entry of targetDirs.filter((item) => item.isDirectory())) {
    rows.push(...await listBackupsForDirectory(path.join(targetRoot, entry.name)));
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function assertBackupBelongsToProfile(profile, backupPath) {
  if (!profile?.folders?.backupFolder) throw new Error('Backup folder is not configured.');
  const profileRoot = path.resolve(path.dirname(backupDirectory(profile.name, 'target', profile.folders.backupFolder)));
  const candidate = path.resolve(backupPath);
  if (!candidate.startsWith(profileRoot + path.sep) || path.extname(candidate).toLowerCase() !== '.zip') {
    throw new Error('Refusing to access a backup outside this profile backup directory.');
  }
  return candidate;
}

export async function verifyBackup(backupPath) {
  const safe = path.resolve(backupPath);
  if (path.extname(safe).toLowerCase() !== '.zip') throw new Error('Only ZIP backup files can be verified.');
  await fs.access(safe);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploypilot-verify-'));
  try {
    await extract(safe, { dir: directory });
    const manifestPath = safe.slice(0, -4) + '.manifest.json';
    let manifest = null;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { /* Missing or malformed sidecar metadata is non-fatal while listing backups. */ }
    return { valid: true, manifest, path: safe };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function deleteBackup(backupPath, backupRoot, confirmed) {
  if (!confirmed) throw new Error('Backup deletion requires confirmation.');
  const base = path.resolve(backupRoot);
  const zip = path.resolve(backupPath);
  if (!zip.startsWith(base + path.sep) || path.extname(zip).toLowerCase() !== '.zip') {
    throw new Error('Refusing to delete a backup outside the configured backup folder.');
  }
  await fs.rm(zip, { force: true });
  await fs.rm(zip.slice(0, -4) + '.manifest.json', { force: true });
}

export async function extractBackup(backupPath, destination) {
  await extract(backupPath, { dir: destination });
  return destination;
}
