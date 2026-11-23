import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractZipSafely } from './zip-extract.js';
import { createConnection } from './connection.js';
import { getProfileWithSecrets } from './profileStore.js';
import { createBackup, assertBackupBelongsToProfile } from './backup.js';
import { scanLocalProject } from './scanner.js';
import { deployDirectory } from './uploader.js';
import { assertSafeRemotePath } from './path-utils.js';
import { recordHistory } from './history.js';

export async function restoreBackup(profileId, backup, confirmed, onProgress) {
  if (!confirmed) throw new Error('Rollback requires confirmation.');
  const { profile, secrets } = await getProfileWithSecrets(profileId);
  backup.path = assertBackupBelongsToProfile(profile, backup.path);
  const target = profile.targets.find((row) => row.id === backup.targetId);
  if (!target) throw new Error('The backup target does not exist in this profile.');
  assertSafeRemotePath(target.remotePath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deploypilot-restore-'));
  let connection;
  try {
    connection = await createConnection(profile, secrets);
    onProgress?.({ step: 'safety-backup', status: 'running' });
    const safetyBackup = await createBackup({ connection, profile, target });
    onProgress?.({ step: 'safety-backup', status: 'success', backup: safetyBackup });
    await extractZipSafely(backup.path, tempRoot);
    const scan = await scanLocalProject(tempRoot, { ...profile.rules, uploadExclude: String(profile.rules?.uploadExclude || '') + '\\nmanifest.json' });
    onProgress?.({ step: 'restore', status: 'running', files: scan.files.length });
    const restored = await deployDirectory({
      connection,
      profile: { ...profile, options: { ...profile.options, strategy: 'staging', deleteRemoved: false } },
      target,
      localRoot: tempRoot,
      localFiles: scan.files,
      onProgress: (data) => onProgress?.({ step: 'restore', status: 'progress', ...data })
    });
    const result = {
      profileId,
      profileName: profile.name,
      status: 'rolled-back',
      target: target.name,
      sourceBackup: backup.path,
      safetyBackup,
      uploaded: restored.plan.uploads.length,
      finishedAt: new Date().toISOString()
    };
    recordHistory(result);
    onProgress?.({ step: 'restore', status: 'success', result });
    return result;
  } finally {
    await connection?.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
