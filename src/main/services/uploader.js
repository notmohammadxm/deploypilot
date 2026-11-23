import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { remoteJoin, assertSafeRemotePath, assertRemoteSibling } from './path-utils.js';
import { isProtectedPath } from './rules.js';
import { createDeploymentPlan } from './planner.js';

function checkCancelled(signal) {
  if (signal?.aborted) throw new Error('Deployment cancelled.');
}

function safeLocal(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe local relative path.');
  const result = path.resolve(root, ...normalized.split('/'));
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Local deployment path escaped its project folder.');
  return result;
}

async function remoteFiles(connection, root, relative = '') {
  const found = [];
  const full = relative ? remoteJoin(root, relative) : assertSafeRemotePath(root);
  const rows = await connection.list(full);
  for (const row of rows) {
    const rel = relative ? relative + '/' + row.name : row.name;
    if (row.isDirectory) found.push({ path: rel, isDirectory: true, size: 0, modifiedAt: row.modifiedAt });
    else if (row.isFile) found.push({ path: rel, isDirectory: false, size: row.size, modifiedAt: row.modifiedAt });
    if (row.isDirectory) found.push(...await remoteFiles(connection, root, rel));
  }
  return found;
}

async function runWithRetries(task, retries, signal) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    checkCancelled(signal);
    try { return await task(); } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * (2 ** attempt))));
    }
  }
  throw lastError;
}

async function runPool(items, concurrency, callback) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await callback(items[index], index);
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function preserveProtectedFiles(connection, targetRoot, stageRoot, rules, tempRoot, signal) {
  const all = await remoteFiles(connection, targetRoot);
  let count = 0;
  for (const item of all.filter((entry) => !entry.isDirectory && isProtectedPath(entry.path, rules))) {
    checkCancelled(signal);
    const local = safeLocal(tempRoot, item.path);
    await fs.mkdir(path.dirname(local), { recursive: true });
    await connection.download(remoteJoin(targetRoot, item.path), local);
    await connection.upload(local, remoteJoin(stageRoot, item.path));
    count += 1;
  }
  return count;
}

async function applyPermissions(connection, remotePath, isDirectory, enabled) {
  if (!enabled || typeof connection.chmod !== 'function') return;
  try { await connection.chmod(remotePath, isDirectory ? 0o755 : 0o644); } catch { /* chmod is best-effort because FTP servers vary. */ }
}

export async function deployDirectory({ connection, profile, target, localRoot, localFiles, signal, onProgress, dryRun = false }) {
  const remoteRoot = assertSafeRemotePath(target.remotePath);
  const existing = await remoteFiles(connection, remoteRoot).catch((error) => {
    if (/not found|no such|550|does not exist/i.test(error.message)) return [];
    throw error;
  });
  const plan = createDeploymentPlan(localFiles, existing, profile.rules, {
    strategy: profile.options?.strategy,
    deleteRemoved: profile.options?.deleteRemoved
  });
  if (dryRun) return { plan, remoteFiles: existing, dryRun: true };

  const protocol = profile.connection?.protocol || 'ftp';
  const concurrency = protocol === 'sftp' ? Math.max(1, Math.min(8, Number(profile.options?.concurrency) || 1)) : 1;
  const retryValue = Number(profile.options?.retries);
  const retries = Number.isFinite(retryValue) ? Math.max(0, Math.min(8, retryValue)) : 2;
  let completed = 0;
  let completedBytes = 0;
  const total = plan.uploads.length + plan.deletions.length;
  const totalBytes = plan.uploads.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const startedAt = Date.now();
  const report = (file, action, bytes = 0) => {
    completedBytes += Number(bytes) || 0;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speedBps = completedBytes / elapsedSeconds;
    const remainingBytes = Math.max(0, totalBytes - completedBytes);
    onProgress?.({
      phase: 'upload',
      file,
      action,
      completed: ++completed,
      total,
      percent: total ? Math.round((completed / total) * 100) : 100,
      completedBytes,
      totalBytes,
      speedBps,
      etaSeconds: speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : null
    });
  };

  const uploadFiles = async (root) => {
    await connection.mkdir(root);
    await runPool(plan.uploads, concurrency, async (file) => {
      checkCancelled(signal);
      const local = safeLocal(localRoot, file.path);
      const remote = remoteJoin(root, file.path);
      await connection.mkdir(path.posix.dirname(remote));
      await runWithRetries(() => connection.upload(local, remote), retries, signal);
      await applyPermissions(connection, remote, false, profile.options?.chmod);
      report(file.path, 'upload', file.size);
    });
    if (profile.options?.chmod) {
      const directories = [...new Set(plan.uploads.map((file) => path.posix.dirname(file.path)).filter((dir) => dir !== '.'))].sort((a, b) => a.length - b.length);
      for (const directory of directories) await applyPermissions(connection, remoteJoin(root, directory), true, true);
    }
  };

  const strategy = profile.options?.strategy || 'staging';
  if (strategy === 'staging') {
    const parent = path.posix.dirname(remoteRoot);
    if (parent === '/') throw new Error('Staging directly under the server root is not allowed.');
    const base = path.posix.basename(remoteRoot);
    const stageRoot = parent + '/' + base + '.__deploy_tmp__';
    const oldRoot = parent + '/' + base + '.__old__';
    assertRemoteSibling(parent, stageRoot);
    assertRemoteSibling(parent, oldRoot);
    await connection.removeDir(stageRoot, parent).catch(() => { /* The stage directory may not exist yet. */ });
    await connection.removeDir(oldRoot, parent).catch(() => { /* A leftover old directory is best-effort cleanup. */ });
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deploypilot-protect-'));
    let movedOld = false;
    try {
      await uploadFiles(stageRoot);
      await preserveProtectedFiles(connection, remoteRoot, stageRoot, profile.rules, tempRoot, signal).catch((error) => {
        if (/not found|no such|550|does not exist/i.test(error.message)) return 0;
        throw error;
      });
      checkCancelled(signal);
      const targetExists = await connection.stat(remoteRoot);
      if (targetExists) {
        await connection.rename(remoteRoot, oldRoot, parent);
        movedOld = true;
      }
      try {
        await connection.rename(stageRoot, remoteRoot, parent);
      } catch (error) {
        if (movedOld) await connection.rename(oldRoot, remoteRoot, parent).catch(() => { /* Preserve the original deployment error if recovery also fails. */ });
        throw error;
      }
      if (movedOld) await connection.removeDir(oldRoot, parent);
    } catch (error) {
      await connection.removeDir(stageRoot, parent).catch(() => { /* Preserve the original deployment error if cleanup fails. */ });
      if (movedOld) {
        const targetNow = await connection.stat(remoteRoot).catch(() => null);
        if (!targetNow) await connection.rename(oldRoot, remoteRoot, parent).catch(() => {});
      }
      throw error;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  } else {
    await uploadFiles(remoteRoot);
    for (const deletion of plan.deletions) {
      checkCancelled(signal);
      await connection.remove(remoteJoin(remoteRoot, deletion.path), remoteRoot);
      report(deletion.path, 'delete');
    }
  }
  return { plan, remoteFiles: existing, dryRun: false };
}

export { remoteFiles };
