import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemotePath, assertSafeRemotePath, assertRemoteWithin, assertRemoteSibling, remoteJoin } from '../src/main/services/path-utils.js';
import { evaluateUploadPath, evaluateBackupPath } from '../src/main/services/rules.js';
import { selectExpiredBackups } from '../src/main/services/retention.js';
import { createDeploymentPlan } from '../src/main/services/planner.js';

test('normalizes Windows and relative paths to POSIX remote paths', () => {
  assert.equal(normalizeRemotePath('var\\www\\site/'), '/var/www/site');
  assert.equal(normalizeRemotePath('/var/www/site'), '/var/www/site');
  assert.equal(remoteJoin('/var/www/site', 'assets/app.js'), '/var/www/site/assets/app.js');
});

test('rejects empty, root, home-root and traversal deployment paths', () => {
  for (const value of ['', '/', '~', '~/www', '/home/alice', '/Users/alice', '/root', '/var/../etc']) {
    assert.throws(() => assertSafeRemotePath(value));
  }
});

test('remote scope prevents prefix confusion and escape', () => {
  assert.equal(assertRemoteWithin('/srv/app', '/srv/app/config/settings.json'), '/srv/app/config/settings.json');
  assert.throws(() => assertRemoteWithin('/srv/app', '/srv/application/config'));
  assert.throws(() => remoteJoin('/srv/app', '../etc/passwd'));
});

test('staging siblings may sit beside a configured child of the account home', () => {
  assert.equal(assertRemoteSibling('/home/alice', '/home/alice/site.__deploy_tmp__'), '/home/alice/site.__deploy_tmp__');
  assert.throws(() => assertRemoteSibling('/home/alice', '/home/alice/other/tmp/file'));
});

test('rule precedence is protect, upload exclude, whitelist, then include', () => {
  const rules = { protect: 'uploads/', uploadExclude: '**', whitelist: '**', whitelistMode: true };
  assert.equal(evaluateUploadPath('uploads/user.jpg', rules).action, 'protected');
  assert.equal(evaluateUploadPath('src/app.js', rules).action, 'skip');
  assert.equal(evaluateUploadPath('src/app.js', { uploadExclude: 'dist/', whitelist: 'src/**', whitelistMode: true }).action, 'include');
  assert.equal(evaluateUploadPath('dist/app.js', { uploadExclude: 'dist/', whitelist: 'dist/**', whitelistMode: true }).reason, 'Upload exclude');
  assert.equal(evaluateUploadPath('readme.md', {}).action, 'include');
});

test('backup exclusions are independent from upload rules', () => {
  assert.equal(evaluateBackupPath('cache/file.bin', { backupExclude: 'cache/' }).action, 'skip');
  assert.equal(evaluateBackupPath('public/index.html', { uploadExclude: 'public/' }).action, 'include');
});

test('retention keeps the most recent N backups', () => {
  const rows = [1, 2, 3, 4].map((day) => ({ id: day, createdAt: '2026-01-0' + day + 'T00:00:00.000Z' }));
  assert.deepEqual(selectExpiredBackups(rows, 2).map((row) => row.id), [2, 1]);
  assert.deepEqual(selectExpiredBackups(rows, 10), []);
});

test('deployment planner calculates changes and honors protected server files', () => {
  const local = [
    { path: 'index.html', size: 20, mtimeMs: 2000 },
    { path: 'uploads/local.txt', size: 8, mtimeMs: 2000 },
    { path: 'assets/new.css', size: 12, mtimeMs: 2000 }
  ];
  const remote = [
    { path: 'index.html', size: 10, modifiedAt: new Date(1000) },
    { path: 'uploads/remote.txt', size: 50, modifiedAt: new Date(1000) },
    { path: 'old.txt', size: 1, modifiedAt: new Date(1000) }
  ];
  const plan = createDeploymentPlan(local, remote, { protect: 'uploads/' }, { strategy: 'diff', deleteRemoved: true });
  assert.deepEqual(plan.uploads.map((row) => row.path), ['index.html', 'assets/new.css']);
  assert.deepEqual(plan.deletions.map((row) => row.path), ['old.txt']);
  assert.ok(plan.skipped.some((row) => row.path === 'uploads/local.txt' && row.reason === 'Protected on server'));
  assert.ok(plan.skipped.some((row) => row.path === 'uploads/remote.txt' && row.reason === 'Protected on server'));
});

test('diff planner skips a same-size file with matching modification time', () => {
  const plan = createDeploymentPlan(
    [{ path: 'app.js', size: 42, mtimeMs: 100000 }],
    [{ path: 'app.js', size: 42, modifiedAt: new Date(100000) }],
    {},
    { strategy: 'diff' }
  );
  assert.equal(plan.uploads.length, 0);
  assert.equal(plan.skipped[0].reason, 'Unchanged (size and modification time)');
});
