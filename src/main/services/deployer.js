import fs from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from './connection.js';
import { getProfileWithSecrets } from './profileStore.js';
import { scanLocalProject } from './scanner.js';
import { createBackup } from './backup.js';
import { deployDirectory, remoteFiles } from './uploader.js';
import { runHook } from './hooks.js';
import { recordHistory } from './history.js';
import { assertSafeRemotePath } from './path-utils.js';
import { evaluateBackupPath } from './rules.js';

function emit(progress, step, status, detail = {}) {
  progress?.({ step, status, at: new Date().toISOString(), ...detail });
}

function validate(profile) {
  if (!profile.name.trim()) throw new Error('Profile name is required.');
  if (!profile.connection?.host || !profile.connection?.username) throw new Error('Server host and username are required.');
  if (!profile.folders?.projectFolder) throw new Error('Choose a local project folder.');
  if (!profile.folders?.backupFolder && profile.options?.backup) throw new Error('Choose a local backup folder or disable backups.');
  if (!Array.isArray(profile.targets) || !profile.targets.some((target) => target.enabled)) throw new Error('Enable at least one remote target.');
  for (const target of profile.targets.filter((item) => item.enabled)) assertSafeRemotePath(target.remotePath);
}

function historyPayload(result) {
  return {
    ...result,
    targets: (result.targets || []).map((entry) => ({
      targetId: entry.targetId,
      targetName: entry.targetName,
      remotePath: entry.remotePath,
      backup: entry.backup || null,
      uploaded: entry.plan?.uploads?.length || 0,
      deleted: entry.plan?.deletions?.length || 0,
      skipped: entry.plan?.skipped?.length || 0
    }))
  };
}

export async function runDeployment(profileId, options = {}) {
  const { profile, secrets } = await getProfileWithSecrets(profileId);
  validate(profile);
  const progress = options.onProgress;
  const signal = options.signal;
  const startedAt = Date.now();
  const dryRun = Boolean(options.dryRun || profile.options?.dryRun);
  const result = { profileId, profileName: profile.name, status: 'running', targets: [], backups: [] };
  let connection;
  try {
    emit(progress, 'validate', 'running');
    const projectRoot = path.resolve(profile.folders.projectFolder);
    const rootStat = await fs.stat(projectRoot);
    if (!rootStat.isDirectory()) throw new Error('The selected project path is not a folder.');
    if (profile.options?.backup) {
      const backupRoot = path.resolve(profile.folders.backupFolder);
      const isInside = (base, candidate) => candidate === base || candidate.startsWith(base + path.sep);
      if (isInside(projectRoot, backupRoot) || isInside(backupRoot, projectRoot)) {
        throw new Error('Choose a backup folder separate from the project folder.');
      }
    }
    emit(progress, 'validate', 'success');
    connection = await createConnection(profile, secrets);
    emit(progress, 'connection', 'success');
    if (signal?.aborted) throw new Error('Deployment cancelled.');

    if (!dryRun && profile.hooks?.preDeploy) {
      emit(progress, 'preDeploy', 'running');
      await runHook(profile.hooks.preDeploy, projectRoot, { profileName: profile.name });
      emit(progress, 'preDeploy', 'success');
    } else emit(progress, 'preDeploy', 'skipped', { reason: dryRun ? 'Disabled during dry run' : 'No hook configured' });

    emit(progress, 'scan', 'running');
    const scan = await scanLocalProject(projectRoot, profile.rules);
    emit(progress, 'scan', 'success', { files: scan.files.length, skipped: scan.skipped.length });

    const enabledTargets = profile.targets.filter((target) => target.enabled);
    for (const target of enabledTargets) {
      if (signal?.aborted) throw new Error('Deployment cancelled.');
      const localRoot = target.localSubfolder ? path.resolve(projectRoot, target.localSubfolder) : projectRoot;
      if (!localRoot.startsWith(projectRoot + path.sep) && localRoot !== projectRoot) {
        throw new Error('Target local mapping must remain inside the project folder.');
      }
      const targetScan = target.localSubfolder ? await scanLocalProject(localRoot, profile.rules) : scan;
      const entry = { targetId: target.id, targetName: target.name, remotePath: target.remotePath, backup: null, plan: null };
      if (profile.options?.backup && dryRun) {
        emit(progress, 'backup', 'running', { target: target.name });
        let files = [];
        try {
          const remote = await remoteFiles(connection, target.remotePath);
          files = remote.filter((item) => !item.isDirectory && evaluateBackupPath(item.path, profile.rules).action === 'include').map((item) => item.path);
        } catch (error) {
          if (!/not found|no such|550|does not exist/i.test(error.message)) throw error;
        }
        entry.backupPlan = files;
        emit(progress, 'backup', 'skipped', { target: target.name, wouldBackup: files.length, backupFiles: files, reason: 'Dry run: backup listed, not downloaded' });
      } else if (profile.options?.backup) {
        emit(progress, 'backup', 'running', { target: target.name });
        try {
          entry.backup = await createBackup({
            connection, profile, target, signal,
            onProgress: (data) => progress?.({ step: 'backup', status: 'progress', target: target.name, ...data })
          });
          result.backups.push(entry.backup);
          emit(progress, 'backup', 'success', { target: target.name, backup: entry.backup });
        } catch (error) {
          emit(progress, 'backup', 'error', { target: target.name, message: error.message });
          if (profile.options?.abortOnBackupFailure !== false) {
            throw new Error('Backup failed for ' + target.name + ': ' + error.message);
          }
        }
      } else emit(progress, 'backup', 'skipped', { target: target.name, reason: 'Backups disabled' });

      emit(progress, dryRun ? 'plan' : 'upload', 'running', { target: target.name });
      const deployed = await deployDirectory({
        connection, profile, target, localRoot, localFiles: targetScan.files, signal, dryRun,
        onProgress: (data) => progress?.({ step: dryRun ? 'plan' : 'upload', target: target.name, ...data })
      });
      entry.plan = deployed.plan;
      entry.remoteFiles = deployed.remoteFiles;
      result.targets.push(entry);
      emit(progress, dryRun ? 'plan' : 'upload', 'success', {
        target: target.name, uploaded: deployed.plan.uploads.length,
        deleted: deployed.plan.deletions.length, skipped: deployed.plan.skipped.length, dryRun
      });
    }

    if (!dryRun && profile.hooks?.postDeploy) {
      emit(progress, 'postDeploy', 'running');
      await runHook(profile.hooks.postDeploy, projectRoot, { profileName: profile.name });
      emit(progress, 'postDeploy', 'success');
    } else emit(progress, 'postDeploy', 'skipped', { reason: dryRun ? 'Disabled during dry run' : 'No hook configured' });

    result.status = dryRun ? 'dry-run' : 'success';
    result.durationMs = Date.now() - startedAt;
    result.finishedAt = new Date().toISOString();
    if (!dryRun) recordHistory(historyPayload(result));
    emit(progress, 'history', dryRun ? 'skipped' : 'success', { result });
    return result;
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : 'failed';
    result.error = error.message;
    result.durationMs = Date.now() - startedAt;
    result.finishedAt = new Date().toISOString();
    recordHistory(historyPayload(result));
    emit(progress, 'complete', 'error', { message: error.message, result });
    throw error;
  } finally {
    await connection?.close().catch(() => { /* Connection teardown must not mask deployment result. */ });
  }
}
