import { safeStorage } from 'electron';

export function encryptSecret(value) {
  if (value === undefined || value === null || value === '') return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential storage is unavailable. DeployPilot will not save credentials in plain text.');
  }
  return safeStorage.encryptString(String(value)).toString('base64');
}

export function decryptSecret(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential storage is unavailable; saved credentials cannot be decrypted.');
  }
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}
