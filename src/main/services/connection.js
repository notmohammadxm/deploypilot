import { Client } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRemotePath, assertRemoteWithin, assertRemoteSibling } from './path-utils.js';

function ftpOptions(profile, secrets) {
  const config = profile.connection || {};
  const secure = config.protocol === 'ftps-explicit' ? true : config.protocol === 'ftps-implicit' ? 'implicit' : false;
  return {
    host: config.host,
    port: Number(config.port) || 21,
    user: config.username,
    password: secrets.password || '',
    secure,
    secureOptions: { rejectUnauthorized: true }
  };
}

class FtpConnection {
  constructor(profile, secrets) {
    this.profile = profile;
    this.client = new Client(Number(profile.connection.timeout) || 30000);
    this.client.ftp.verbose = false;
    this.secrets = secrets;
  }
  async connect() { await this.client.access(ftpOptions(this.profile, this.secrets)); }
  async list(remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    const rows = await this.client.list(safe);
    return rows.filter((row) => row.name !== '.' && row.name !== '..').map((row) => ({
      name: row.name, isDirectory: row.isDirectory, isFile: row.isFile,
      size: Number(row.size) || 0, modifiedAt: row.modifiedAt || null
    }));
  }
  async stat(remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    try {
      const directory = path.posix.dirname(safe);
      const name = path.posix.basename(safe);
      const entries = await this.client.list(directory);
      const entry = entries.find((row) => row.name === name);
      return entry ? { size: Number(entry.size) || 0, isDirectory: entry.isDirectory, modifiedAt: entry.modifiedAt || null } : null;
    } catch { return null; }
  }
  async mkdir(remotePath) { await this.client.ensureDir(assertSafeRemotePath(remotePath)); }
  async upload(localPath, remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    await this.client.ensureDir(path.posix.dirname(safe));
    await this.client.uploadFrom(localPath, safe);
  }
  async download(remotePath, localPath) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await this.client.downloadTo(localPath, assertSafeRemotePath(remotePath));
  }
  async chmod(remotePath, mode) {
    const safe = assertSafeRemotePath(remotePath);
    const octal = Number(mode).toString(8);
    await this.client.send('SITE CHMOD ' + octal + ' "' + safe.replace(/"/g, '') + '"');
  }
  async rename(from, to, scope) {
    if (scope) { assertRemoteSibling(scope, from); assertRemoteSibling(scope, to); }
    else { assertSafeRemotePath(from); assertSafeRemotePath(to); }
    await this.client.rename(from, to);
  }
  async remove(remotePath, scope) {
    if (scope) assertRemoteWithin(scope, remotePath); else assertSafeRemotePath(remotePath);
    await this.client.remove(remotePath);
  }
  async removeDir(remotePath, scope) {
    if (scope) assertRemoteSibling(scope, remotePath); else assertSafeRemotePath(remotePath);
    await this.client.removeDir(remotePath);
  }
  async close() { this.client.close(); }
}

class SftpConnection {
  constructor(profile, secrets) {
    this.profile = profile;
    this.client = new SftpClient('DeployPilot');
    this.secrets = secrets;
  }
  async connect() {
    const config = this.profile.connection || {};
    const options = { host: config.host, port: Number(config.port) || 22, username: config.username, readyTimeout: Number(config.timeout) || 30000 };
    if (this.secrets.privateKey) options.privateKey = this.secrets.privateKey;
    else options.password = this.secrets.password || '';
    if (this.secrets.passphrase) options.passphrase = this.secrets.passphrase;
    await this.client.connect(options);
  }
  async list(remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    const rows = await this.client.list(safe);
    return rows.filter((row) => row.name !== '.' && row.name !== '..').map((row) => ({
      name: row.name, isDirectory: row.type === 'd', isFile: row.type !== 'd',
      size: Number(row.size) || 0, modifiedAt: row.modifyTime ? new Date(Number(row.modifyTime) * 1000) : null
    }));
  }
  async stat(remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    try {
      const row = await this.client.stat(safe);
      return { size: Number(row.size) || 0, isDirectory: row.isDirectory, modifiedAt: row.modifyTime ? new Date(Number(row.modifyTime) * 1000) : null };
    } catch { return null; }
  }
  async mkdir(remotePath) { await this.client.mkdir(assertSafeRemotePath(remotePath), true); }
  async upload(localPath, remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    await this.client.mkdir(path.posix.dirname(safe), true);
    await this.client.fastPut(localPath, safe);
  }
  async download(remotePath, localPath) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await this.client.fastGet(assertSafeRemotePath(remotePath), localPath);
  }
  async chmod(remotePath, mode) { await this.client.chmod(assertSafeRemotePath(remotePath), Number(mode)); }
  async rename(from, to, scope) {
    if (scope) { assertRemoteSibling(scope, from); assertRemoteSibling(scope, to); }
    else { assertSafeRemotePath(from); assertSafeRemotePath(to); }
    await this.client.rename(from, to);
  }
  async remove(remotePath, scope) {
    if (scope) assertRemoteWithin(scope, remotePath); else assertSafeRemotePath(remotePath);
    await this.client.delete(remotePath);
  }
  async removeDir(remotePath, scope) {
    if (scope) assertRemoteSibling(scope, remotePath); else assertSafeRemotePath(remotePath);
    await this.removeTree(remotePath);
  }
  async removeTree(remotePath) {
    const safe = assertSafeRemotePath(remotePath);
    const rows = await this.client.list(safe);
    for (const row of rows) {
      const child = safe + '/' + row.name;
      assertRemoteWithin(safe, child);
      if (row.type === 'd') await this.removeTree(child);
      else await this.client.delete(child);
    }
    await this.client.rmdir(safe);
  }
  async close() { await this.client.end().catch(() => {}); }
}

export async function createConnection(profile, secrets = {}) {
  const protocol = profile.connection?.protocol || 'ftp';
  const connection = protocol === 'sftp' ? new SftpConnection(profile, secrets) : new FtpConnection(profile, secrets);
  await connection.connect();
  return connection;
}
