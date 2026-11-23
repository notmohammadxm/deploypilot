import { ipcMain, dialog, BrowserWindow, Notification, app, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import log from 'electron-log/main';
import {
  listProfiles, getProfile, saveProfile, duplicateProfile, deleteProfile,
  importProfiles, exportProfiles, getProfileWithSecrets, getHistory, getSettings, saveSettings
} from './services/profileStore.js';
import { createConnection } from './services/connection.js';
import { runDeployment } from './services/deployer.js';
import { listBackups, verifyBackup, deleteBackup, assertBackupBelongsToProfile } from './services/backup.js';
import { restoreBackup } from './services/rollback.js';
import { assertSafeRemotePath, remoteJoin } from './services/path-utils.js';
import { evaluateUploadPath } from './services/rules.js';

const jobs = new Map();
const window = () => BrowserWindow.getAllWindows()[0] || null;
const send = (channel, payload) => window()?.webContents.send(channel, payload);

function requireConfirmed(value, action) {
  if (value !== true) throw new Error(action + ' requires confirmation.');
}

export function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:minimize', () => window()?.minimize());
  ipcMain.handle('app:toggle-maximize', () => {
    const current = window();
    if (!current) return false;
    if (current.isMaximized()) current.unmaximize(); else current.maximize();
    return current.isMaximized();
  });
  ipcMain.handle('app:close', () => window()?.close());

  ipcMain.handle('profiles:list', () => listProfiles());
  ipcMain.handle('profiles:get', (_event, id) => getProfile(id));
  ipcMain.handle('profiles:save', async (_event, profile, credentials) => saveProfile(profile, credentials || {}));
  ipcMain.handle('profiles:duplicate', async (_event, id) => duplicateProfile(id));
  ipcMain.handle('profiles:delete', async (_event, id, confirmed) => {
    requireConfirmed(confirmed, 'Profile deletion');
    await deleteProfile(id);
    return true;
  });
  ipcMain.handle('profiles:export', async (_event, ids) => {
    const result = await dialog.showSaveDialog(window(), {
      title: 'Export DeployPilot profiles',
      defaultPath: 'deploypilot-profiles.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, exportProfiles(ids), { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('profiles:import', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: 'Import DeployPilot profiles',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const content = await fs.readFile(result.filePaths[0], 'utf8');
    return { canceled: false, profiles: await importProfiles(content) };
  });

  ipcMain.handle('files:pick-folder', async (_event, title) => {
    const result = await dialog.showOpenDialog(window(), { title: title || 'Select folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('files:pick-private-key', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: 'Select SSH private key',
      properties: ['openFile'],
      filters: [{ name: 'Private key', extensions: ['pem', 'key', 'ppk', ''] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('files:open-path', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw new Error('Invalid local path.');
    const result = await shell.openPath(targetPath);
    if (result) throw new Error(result);
    return true;
  });

  ipcMain.handle('connection:test', async (_event, profileId) => {
    const { profile, secrets } = await getProfileWithSecrets(profileId);
    const connection = await createConnection(profile, secrets);
    try {
      const target = profile.targets.find((row) => row.enabled && row.remotePath);
      if (target) await connection.list(assertSafeRemotePath(target.remotePath));
      log.info('Connection test succeeded for profile:', profile.id);
      return { success: true, message: 'Connection established successfully.' };
    } finally {
      await connection.close();
    }
  });

  ipcMain.handle('connection:list-remote', async (_event, profileId, remotePath) => {
    const safe = assertSafeRemotePath(remotePath);
    const { profile, secrets } = await getProfileWithSecrets(profileId);
    const connection = await createConnection(profile, secrets);
    try {
      const entries = await connection.list(safe);
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: Boolean(entry.isDirectory),
        size: Number(entry.size) || 0,
        modifiedAt: entry.modifiedAt || null,
        path: remoteJoin(safe, entry.name)
      }));
    } finally {
      await connection.close();
    }
  });

  ipcMain.handle('deploy:start', async (_event, profileId, settings = {}) => {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    if (profile.isProduction) {
      requireConfirmed(settings.confirmed, 'Production deployment');
      if (settings.confirmName !== profile.name) throw new Error('Type the exact project name to confirm this production deployment.');
    } else requireConfirmed(settings.confirmed, 'Deployment');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    jobs.set(id, controller);
    setImmediate(async () => {
      try {
        const result = await runDeployment(profileId, {
          signal: controller.signal,
          dryRun: Boolean(settings.dryRun),
          onProgress: (data) => send('deploy:progress', { jobId: id, ...data })
        });
        send('deploy:finished', { jobId: id, result });
        const globalSettings = getSettings();
        if (globalSettings.notifications !== false && !settings.dryRun && Notification.isSupported()) {
          new Notification({ title: 'DeployPilot', body: profile.name + ' deployment completed.' }).show();
        }
      } catch (error) {
        send('deploy:error', { jobId: id, message: error.message });
        log.error('Deployment failed for profile:', profile.id, error.message);
      } finally {
        jobs.delete(id);
      }
    });
    return { jobId: id };
  });
  ipcMain.handle('deploy:cancel', async (_event, jobId) => {
    const controller = jobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle('backups:list', async (_event, profileId) => {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    if (!profile.folders.backupFolder) return [];
    return listBackups(profile);
  });
  ipcMain.handle('backups:verify', async (_event, profileId, backupPath) => {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    return verifyBackup(assertBackupBelongsToProfile(profile, backupPath));
  });
  ipcMain.handle('backups:delete', async (_event, profileId, backupPath, confirmed) => {
    requireConfirmed(confirmed, 'Backup deletion');
    const profile = getProfile(profileId);
    if (!profile?.folders.backupFolder) throw new Error('Backup folder is not configured.');
    const safeBackup = assertBackupBelongsToProfile(profile, backupPath);
    const profileBackupRoot = path.dirname(path.dirname(safeBackup));
    await deleteBackup(safeBackup, profileBackupRoot, confirmed);
    return true;
  });
  ipcMain.handle('backups:restore', async (_event, profileId, backup, confirmed) => {
    requireConfirmed(confirmed, 'Rollback');
    const profile = getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    backup.path = assertBackupBelongsToProfile(profile, backup.path);
    return restoreBackup(profileId, backup, confirmed, (data) => send('deploy:progress', data));
  });

  ipcMain.handle('rules:test', (_event, rules, relativePath) => {
    if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.startsWith('/') || relativePath.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
      throw new Error('Enter a safe project-relative path to test.');
    }
    return evaluateUploadPath(relativePath, rules || {});
  });
  ipcMain.handle('history:list', () => getHistory());
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:save', (_event, patch) => saveSettings(patch || {}));
  ipcMain.handle('logs:read', async () => {
    const file = log.transports.file.getFile().path;
    try {
      const data = await fs.readFile(file, 'utf8');
      return data.slice(-1_000_000);
    } catch { return ''; }
  });
  ipcMain.handle('logs:diagnostics', async () => {
    const file = log.transports.file.getFile().path;
    return [
      'DeployPilot ' + app.getVersion(),
      'Platform: ' + process.platform + ' ' + process.arch,
      'Electron: ' + process.versions.electron,
      'Node: ' + process.versions.node,
      'User data: ' + app.getPath('userData'),
      'Log file: ' + file,
      'Profiles: ' + listProfiles().length
    ].join('\\n');
  });
}
