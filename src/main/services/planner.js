import { evaluateUploadPath, isProtectedPath } from './rules.js';

function sameRemoteFile(local, remote) {
  if (!remote || Number(remote.size) !== Number(local.size)) return false;
  if (!remote.modifiedAt || !local.mtimeMs) return true;
  const remoteMs = remote.modifiedAt instanceof Date
    ? remote.modifiedAt.getTime()
    : new Date(remote.modifiedAt).getTime();
  return Number.isFinite(remoteMs) && Math.abs(remoteMs - Number(local.mtimeMs)) < 2000;
}

export function createDeploymentPlan(localFiles, remoteFiles, rules, options = {}) {
  const remoteByPath = new Map((remoteFiles || []).filter((file) => !file.isDirectory).map((file) => [file.path, file]));
  const localByPath = new Map();
  const uploads = [];
  const skipped = [];
  for (const file of localFiles || []) {
    localByPath.set(file.path, file);
    const decision = evaluateUploadPath(file.path, rules);
    if (decision.action !== 'include') {
      skipped.push({ path: file.path, reason: decision.reason });
      continue;
    }
    const existing = remoteByPath.get(file.path);
    if (options.strategy === 'diff' && sameRemoteFile(file, existing)) {
      skipped.push({ path: file.path, reason: 'Unchanged (size and modification time)' });
      continue;
    }
    uploads.push({ ...file, action: existing ? 'replace' : 'upload' });
  }
  const deletions = [];
  if (options.strategy === 'diff' && options.deleteRemoved) {
    for (const remote of remoteFiles || []) {
      if (remote.isDirectory || localByPath.has(remote.path)) continue;
      if (isProtectedPath(remote.path, rules)) {
        skipped.push({ path: remote.path, reason: 'Protected on server' });
      } else {
        deletions.push({ path: remote.path, action: 'delete' });
      }
    }
  }
  return { uploads, deletions, skipped, total: uploads.length + deletions.length };
}

export function formatPlanSummary(plan) {
  return {
    upload: plan.uploads.length,
    delete: plan.deletions.length,
    skipped: plan.skipped.length,
    files: plan.uploads.map((file) => file.path),
    deleted: plan.deletions.map((file) => file.path),
    skippedFiles: plan.skipped
  };
}
