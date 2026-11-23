import Store from 'electron-store';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from './secrets.js';

const store = new Store({
  name: 'deploypilot',
  defaults: { profiles: [], history: [], settings: { startMinimized: false, notifications: true } }
});

export function defaultProfile() {
  return {
    id: crypto.randomUUID(),
    name: 'New project',
    color: '#14b8a6',
    description: '',
    connection: { protocol: 'ftp', host: '', port: 21, username: '', passive: true, timeout: 30000, retries: 2, privateKeyPath: '' },
    folders: { projectFolder: '', backupFolder: '' },
    targets: [],
    rules: { uploadExclude: 'node_modules/\\n.git/\\n.env\\n.env.*', backupExclude: '', protect: '', whitelist: '', whitelistMode: false },
    options: { backup: true, abortOnBackupFailure: true, strategy: 'staging', deleteRemoved: false, concurrency: 4, retries: 2, timeout: 30000, chmod: false, maintenanceFile: '', retention: 10, dryRun: false },
    hooks: { preDeploy: '', postDeploy: '' },
    isProduction: false
  };
}

function publicProfile(profile) {
  const copy = structuredClone(profile);
  delete copy.secret;
  if (copy.connection) delete copy.connection.privateKeyPath;
  return copy;
}

async function preserveConfigCopy() {
  try {
    const configPath = store.path;
    await fs.access(configPath);
    await fs.copyFile(configPath, configPath + '.bak');
  } catch {}
}

export function listProfiles() {
  return store.get('profiles', []).map(publicProfile);
}

export function getProfile(id) {
  const profile = store.get('profiles', []).find((entry) => entry.id === id);
  return profile ? publicProfile(profile) : null;
}

export async function getProfileWithSecrets(id) {
  const profile = store.get('profiles', []).find((entry) => entry.id === id);
  if (!profile) throw new Error('The selected profile no longer exists.');
  return {
    profile: publicProfile(profile),
    secrets: {
      password: decryptSecret(profile.secret?.password),
      privateKey: decryptSecret(profile.secret?.privateKey),
      passphrase: decryptSecret(profile.secret?.passphrase)
    }
  };
}

export async function saveProfile(input, credentials = {}) {
  if (!input || typeof input !== 'object') throw new Error('Invalid profile data.');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Profile name is required.');
  const profiles = store.get('profiles', []);
  const existingIndex = profiles.findIndex((entry) => entry.id === input.id);
  const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
  const next = structuredClone(input);
  next.id = existing?.id || input.id || crypto.randomUUID();
  next.connection = { ...(next.connection || {}) };
  next.secret = { ...(existing?.secret || {}) };
  if (Object.hasOwn(credentials, 'password')) next.secret.password = encryptSecret(credentials.password);
  if (Object.hasOwn(credentials, 'passphrase')) next.secret.passphrase = encryptSecret(credentials.passphrase);
  if (credentials.privateKeyPath) {
    const keyText = await fs.readFile(credentials.privateKeyPath, 'utf8');
    next.secret.privateKey = encryptSecret(keyText);
  }
  if (!credentials.privateKeyPath && credentials.clearPrivateKey) next.secret.privateKey = '';
  delete next.connection.privateKeyPath;
  await preserveConfigCopy();
  if (existingIndex >= 0) profiles[existingIndex] = next;
  else profiles.push(next);
  store.set('profiles', profiles);
  return publicProfile(next);
}

export async function duplicateProfile(id) {
  const current = store.get('profiles', []).find((entry) => entry.id === id);
  if (!current) throw new Error('Profile not found.');
  const duplicate = structuredClone(current);
  duplicate.id = crypto.randomUUID();
  duplicate.name = current.name + ' copy';
  await preserveConfigCopy();
  store.set('profiles', [...store.get('profiles', []), duplicate]);
  return publicProfile(duplicate);
}

export async function deleteProfile(id) {
  await preserveConfigCopy();
  store.set('profiles', store.get('profiles', []).filter((entry) => entry.id !== id));
}

export function exportProfiles(ids) {
  const selected = store.get('profiles', []).filter((profile) => !ids?.length || ids.includes(profile.id));
  return JSON.stringify({ version: 1, profiles: selected.map(publicProfile) }, null, 2);
}

export async function importProfiles(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw new Error('The selected profile file is not valid JSON.'); }
  const incoming = Array.isArray(parsed) ? parsed : parsed.profiles;
  if (!Array.isArray(incoming)) throw new Error('The import file does not contain a profiles array.');
  const imported = [];
  for (const raw of incoming) {
    const profile = { ...defaultProfile(), ...raw, id: crypto.randomUUID() };
    delete profile.secret;
    if (profile.connection) delete profile.connection.privateKeyPath;
    imported.push(profile);
  }
  await preserveConfigCopy();
  store.set('profiles', [...store.get('profiles', []), ...imported]);
  return imported.map(publicProfile);
}

export function getHistory() { return store.get('history', []); }

export function addHistory(record) {
  const history = [record, ...store.get('history', [])].slice(0, 500);
  store.set('history', history);
  return record;
}

export function getHistoryEntry(id) { return getHistory().find((row) => row.id === id) || null; }

export function getSettings() { return store.get('settings', {}); }

export function saveSettings(patch) {
  store.set('settings', { ...getSettings(), ...patch });
  return getSettings();
}

export function getStorePath() { return store.path; }
export function backupDirectory(profileName, targetName, root) {
  const safe = (value) => String(value || 'unnamed').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.+$/g, '').slice(0, 70) || 'unnamed';
  return path.join(root, safe(profileName), safe(targetName));
}
