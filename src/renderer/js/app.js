const api = window.deployPilot;
const state = {
  profiles: [], activeId: null, page: 'deploy', backups: [], history: [], logs: '',
  settings: {}, jobId: null, events: [], deployResult: null, rulePath: ''
};

const pageMeta = {
  projects: ['PROJECT MANAGEMENT', 'Projects', 'Manage connection profiles and deployment targets.'],
  deploy: ['DEPLOYMENT WORKSPACE', 'Deploy', 'Publish your project to one or more remote targets.'],
  backups: ['RECOVERY & RESTORE', 'Backups', 'Verify, inspect, and restore deployment snapshots.'],
  rules: ['DEPLOYMENT FILTERS', 'Rules', 'Control uploads, backup exclusions, and protected server paths.'],
  history: ['ACTIVITY RECORD', 'History', 'Review recent publishes and roll back to a verified backup.'],
  logs: ['DIAGNOSTICS', 'Logs', 'Inspect application activity and troubleshoot connection issues.'],
  settings: ['APPLICATION', 'Settings', 'Configure local application behavior and diagnostics.']
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const activeProfile = () => state.profiles.find((profile) => profile.id === state.activeId) || null;
const dateText = (value) => value ? new Date(value).toLocaleString() : '—';
const speedText = (value) => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB/s' : value >= 1024 ? (value / 1024).toFixed(0) + ' KB/s' : Math.round(value || 0) + ' B/s';
const uuid = () => crypto.randomUUID();
const profileProtocol = (profile) => ({ ftp: 'FTP', 'ftps-explicit': 'FTPS · Explicit', 'ftps-implicit': 'FTPS · Implicit', sftp: 'SFTP' })[profile.connection?.protocol] || 'FTP';

function toast(message, kind = 'success') {
  const item = document.createElement('div');
  item.className = 'toast ' + kind;
  item.textContent = message;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), 4200);
}
function setStatus(message, operation = '') {
  $('#connection-status').textContent = message;
  $('#operation-status').textContent = operation || 'Idle';
  const profile = activeProfile();
  $('#current-profile-status').textContent = profile ? profile.name : 'No profile selected';
}
function defaultProfile() {
  return {
    id: uuid(), name: 'New project', color: '#14b8a6', description: '',
    connection: { protocol: 'ftp', host: '', port: 21, username: '', passive: true, timeout: 30000, retries: 2 },
    folders: { projectFolder: '', backupFolder: '' }, targets: [],
    rules: { uploadExclude: 'node_modules/\n.git/\n.env\n.env.*', backupExclude: '', protect: '', whitelist: '', whitelistMode: false },
    options: { backup: true, abortOnBackupFailure: true, strategy: 'staging', deleteRemoved: false, concurrency: 4, retries: 2, timeout: 30000, chmod: false, maintenanceFile: '', retention: 10, dryRun: false },
    hooks: { preDeploy: '', postDeploy: '' }, isProduction: false
  };
}

function render() {
  const meta = pageMeta[state.page] || pageMeta.deploy;
  $('#page-eyebrow').textContent = meta[0];
  $('#page-title').textContent = meta[1];
  $('#page-subtitle').textContent = meta[2];
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === state.page));
  $('#profile-count').textContent = String(state.profiles.length);
  const actions = $('#page-actions');
  actions.innerHTML = '';
  if (state.page === 'projects') actions.innerHTML = '<button class="btn" id="import-profiles">Import</button><button class="btn" id="export-profiles">Export all</button><button class="btn primary" id="new-profile">＋ New profile</button>';
  if (state.page === 'deploy') actions.innerHTML = '<button class="btn" id="edit-active">Edit profile</button><button class="btn primary" id="publish-top">↗ Publish</button>';
  if (state.page === 'backups') actions.innerHTML = '<button class="btn" id="refresh-backups">↻ Refresh</button>';
  if (state.page === 'history') actions.innerHTML = '<button class="btn" id="refresh-history">↻ Refresh</button>';
  if (state.page === 'logs') actions.innerHTML = '<button class="btn" id="copy-diagnostics">Copy diagnostics</button><button class="btn" id="refresh-logs">↻ Refresh</button>';
  if (state.page === 'settings') actions.innerHTML = '<button class="btn" id="copy-diagnostics">Copy diagnostics</button>';
  const content = $('#page-content');
  if (state.page === 'projects') renderProjects(content);
  else if (state.page === 'deploy') renderDeploy(content);
  else if (state.page === 'backups') renderBackups(content);
  else if (state.page === 'rules') renderRules(content);
  else if (state.page === 'history') renderHistory(content);
  else if (state.page === 'logs') renderLogs(content);
  else renderSettings(content);
  setStatus('Ready');
}

function renderProjects(root) {
  if (!state.profiles.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">▦</div><h3>No deployment profiles yet</h3><p>Create a profile to save your project folder, server credentials, remote targets, rules, and deployment options.</p><button class="btn primary" id="empty-new-profile">＋ Create your first profile</button></div>';
    return;
  }
  root.innerHTML = '<div class="grid">' + state.profiles.map((profile) => {
    const targets = (profile.targets || []).filter((target) => target.enabled).length;
    return '<div class="card profile-card span-4"><div class="profile-card-top"><div class="profile-color" style="background:' + esc(profile.color || '#14b8a6') + '"></div><div class="profile-meta"><strong>' + esc(profile.name) + '</strong><span>' + esc(profileProtocol(profile)) + ' · ' + esc(profile.connection?.host || 'No server host') + '</span></div>' + (profile.isProduction ? '<span class="tag warning">Production</span>' : '') + '</div><div class="profile-description">' + esc(profile.description || 'No description added.') + '</div><div class="profile-card-footer"><span class="tag">' + targets + ' enabled target' + (targets === 1 ? '' : 's') + '</span><div class="row-actions"><button class="btn small" data-edit="' + esc(profile.id) + '">Edit</button><button class="btn small" data-deploy="' + esc(profile.id) + '">Deploy</button><button class="icon-btn" data-more="' + esc(profile.id) + '" aria-label="More profile actions">···</button></div></div></div>';
  }).join('') + '</div>';
}

function renderDeploy(root) {
  const profile = activeProfile();
  if (!profile) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">↗</div><h3>Select a deployment profile</h3><p>DeployPilot keeps each project connection, target, and rule set isolated in its own profile.</p><button class="btn primary" id="empty-new-profile">＋ Create profile</button></div>';
    return;
  }
  const targets = profile.targets || [];
  const enabled = targets.filter((target) => target.enabled);
  const options = state.profiles.map((row) => '<option value="' + esc(row.id) + '"' + (row.id === profile.id ? ' selected' : '') + '>' + esc(row.name) + '</option>').join('');
  root.innerHTML = '<div class="grid">' +
    '<div class="span-8 card"><div class="card-header"><div><div class="card-title"><h3>Deployment profile</h3><span class="tag accent">' + esc(profileProtocol(profile)) + '</span>' + (profile.isProduction ? '<span class="tag warning">Production</span>' : '') + '</div><div class="card-subtitle">Choose the profile and confirm the server targets before publishing.</div></div><button class="btn small" id="test-connection">◎ Test connection</button></div>' +
    '<div class="form-field"><label for="deploy-profile">Active profile</label><select id="deploy-profile">' + options + '</select></div><div class="section-divider"></div>' +
    '<div class="grid"><div class="span-6"><div class="field-label">LOCAL PROJECT</div><div class="path-text mt-12">' + esc(profile.folders?.projectFolder || 'Project folder not selected') + '</div></div><div class="span-6"><div class="field-label">LOCAL BACKUPS</div><div class="path-text mt-12">' + esc(profile.folders?.backupFolder || 'Backup folder not selected') + '</div></div></div>' +
    '<div class="section-divider"></div><div class="card-header"><div><h3>Remote targets</h3><div class="card-subtitle">' + enabled.length + ' of ' + targets.length + ' targets enabled</div></div><button class="btn small" id="edit-targets">Manage targets</button></div>' +
    (targets.length ? targets.map((target) => '<div class="target-row"><div class="target-info"><strong>' + esc(target.name) + '</strong><span>' + (target.enabled ? 'Enabled' : 'Disabled') + '</span></div><div class="path-text">' + esc(target.remotePath || 'Path not configured') + '</div><div class="target-info"><span>' + esc(target.localSubfolder || 'Project root') + '</span></div><div class="target-actions"><button class="btn small" data-browse="' + esc(target.id) + '">Browse</button><span class="tag ' + (target.enabled ? 'success' : '') + '">' + (target.enabled ? 'On' : 'Off') + '</span></div></div>').join('') : '<div class="empty-state"><p>No targets configured. Add at least one target before deployment.</p><button class="btn" id="edit-targets">Configure targets</button></div>') +
    '<div class="section-divider"></div><div class="flex between wrap"><label class="checkbox-row"><input id="dry-run" type="checkbox" ' + (profile.options?.dryRun ? 'checked' : '') + '> Dry run · show exact upload and delete plan</label><span class="muted">Strategy: ' + esc((profile.options?.strategy || 'staging').toUpperCase()) + '</span></div>' +
    '<div class="flex between mt-16"><span class="muted">Concurrency: ' + esc(profile.options?.concurrency || 1) + ' · Retries: ' + esc(profile.options?.retries ?? 2) + '</span><button class="btn primary" id="publish-main" ' + (!enabled.length ? 'disabled' : '') + '>↗ Publish project</button></div></div>' +
    '<div class="span-4"><div class="stat-card"><div class="stat-label">ENABLED TARGETS</div><div class="stat-value">' + enabled.length + '</div><div class="stat-foot">Each target is backed up before deployment.</div></div><div class="stat-card mt-12"><div class="stat-label">BACKUP POLICY</div><div class="stat-value">' + (profile.options?.backup ? 'On' : 'Off') + '</div><div class="stat-foot">' + (profile.options?.backup ? 'Retention: last ' + esc(profile.options?.retention || 10) + ' snapshots per target.' : 'No automatic safety snapshot.') + '</div></div><div class="stat-card mt-12"><div class="stat-label">SERVER</div><div class="stat-value" style="font-size:15px;word-break:break-word">' + esc(profile.connection?.host || 'Not configured') + '</div><div class="stat-foot">' + esc(profile.connection?.username || 'No username') + ' · Port ' + esc(profile.connection?.port || '—') + '</div></div></div>' +
    '<div class="span-12 card"><div class="card-header"><div><h3>Publish activity</h3><div class="card-subtitle">Live pipeline progress and deployment output</div></div><button class="btn small danger" id="cancel-deploy" ' + (state.jobId ? '' : 'disabled') + '>Cancel deployment</button></div><div class="steps" id="deploy-steps">' + ['Validate','Connect','Pre-deploy','Scan','Backup','Upload','Post-deploy','History'].map((name) => '<div class="step" data-step="' + name.toLowerCase().replace(/[^a-z]/g, '') + '"><div class="step-name">' + name + '</div><div class="step-state">Waiting</div></div>').join('') + '</div><div class="flex between mt-12"><span class="muted" id="deploy-message">No deployment running.</span><span class="muted" id="deploy-percent">0%</span></div><div class="progress-track mt-12"><div class="progress-fill" id="deploy-progress"></div></div><div class="console mt-12" id="deploy-console"><div class="muted">Deployment logs will appear here.</div></div><div id="plan-output" class="mt-12"></div></div></div>';
  if (state.events.length) renderDeployEvents();
  if (state.deployResult) showDeployResult(state.deployResult);
}

function renderBackups(root) {
  const profile = activeProfile();
  if (!profile) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">◷</div><h3>Select a profile first</h3><p>Backups are grouped by profile and target. Choose a profile from Projects or Deploy.</p></div>';
    return;
  }
  if (!profile.folders?.backupFolder) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">◷</div><h3>Backup folder not configured</h3><p>Edit this profile and choose a local backup folder. Automatic backups are created before each deployment.</p><button class="btn" id="edit-active">Edit profile</button></div>';
    return;
  }
  root.innerHTML = '<div class="card"><div class="card-header"><div><h3>Snapshots for ' + esc(profile.name) + '</h3><div class="card-subtitle path-text">' + esc(profile.folders.backupFolder) + '</div></div><span class="tag">' + state.backups.length + ' backups</span></div><div class="table-wrap"><table><thead><tr><th>Created</th><th>Target</th><th>Files</th><th>Verification</th><th>Actions</th></tr></thead><tbody>' +
    (state.backups.length ? state.backups.map((backup) => '<tr><td>' + esc(dateText(backup.createdAt)) + '</td><td><strong>' + esc(backup.targetName) + '</strong><div class="path-text">' + esc(backup.remotePath) + '</div></td><td>' + esc(backup.fileCount) + '</td><td><span class="tag">Not checked</span></td><td><div class="row-actions"><button class="btn small" data-verify="' + esc(backup.path) + '">Verify</button><button class="btn small" data-restore="' + esc(backup.id) + '">Restore</button><button class="btn small" data-open-backup="' + esc(backup.path) + '">Open</button><button class="btn small danger" data-delete-backup="' + esc(backup.path) + '">Delete</button></div></td></tr>').join('') : '<tr><td colspan="5" class="muted">No backups found for this profile.</td></tr>') +
    '</tbody></table></div></div>';
}

function renderRules(root) {
  const profile = activeProfile();
  if (!profile) {
    root.innerHTML = '<div class="empty-state"><h3>Select a profile first</h3><p>Rules are stored independently in each deployment profile.</p></div>';
    return;
  }
  const rules = profile.rules || {};
  root.innerHTML = '<div class="grid"><div class="span-6 card"><div class="card-header"><div><h3>Upload exclude</h3><div class="card-subtitle">Files and folders never sent to the server.</div></div></div><textarea id="rule-upload" spellcheck="false">' + esc(rules.uploadExclude || '') + '</textarea></div><div class="span-6 card"><div class="card-header"><div><h3>Backup exclude</h3><div class="card-subtitle">Remote server paths omitted from local ZIP snapshots.</div></div></div><textarea id="rule-backup" spellcheck="false">' + esc(rules.backupExclude || '') + '</textarea></div><div class="span-6 card"><div class="card-header"><div><h3>Protect on server</h3><div class="card-subtitle">Protected paths are preserved during staging and never overwritten or deleted.</div></div></div><textarea id="rule-protect" spellcheck="false">' + esc(rules.protect || '') + '</textarea></div><div class="span-6 card"><div class="card-header"><div><h3>Whitelist</h3><div class="card-subtitle">In whitelist mode, only matching upload paths are included.</div></div></div><textarea id="rule-whitelist" spellcheck="false">' + esc(rules.whitelist || '') + '</textarea><label class="checkbox-row mt-12"><input id="rule-whitelist-mode" type="checkbox" ' + (rules.whitelistMode ? 'checked' : '') + '> Enable whitelist mode</label></div><div class="span-12 card"><div class="card-header"><div><h3>Rule tester</h3><div class="card-subtitle">Test an individual project-relative path against upload precedence.</div></div><select id="rule-preset" style="max-width:190px"><option value="">Load preset…</option><option>PHP</option><option>Laravel</option><option>WordPress</option><option>Node</option><option>Static</option><option>ReactVue</option></select></div><div class="rule-tester"><input id="rule-test-path" value="' + esc(state.rulePath) + '" placeholder="e.g. storage/logs/app.log"><button class="btn" id="test-rule">Test path</button><button class="btn primary" id="save-rules">Save rules</button></div><div class="rule-result" id="rule-result">Precedence: Protect → Exclude → Whitelist → Default include.</div></div></div>';
}

function renderHistory(root) {
  root.innerHTML = '<div class="card"><div class="card-header"><div><h3>Deployment history</h3><div class="card-subtitle">Up to 500 recent deployment and rollback records.</div></div><span class="tag">' + state.history.length + ' entries</span></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Project</th><th>Status</th><th>Targets</th><th>Duration</th><th>Actions</th></tr></thead><tbody>' +
    (state.history.length ? state.history.map((record) => {
      const status = record.status || 'unknown';
      const statusClass = status === 'success' || status === 'rolled-back' ? 'success' : status === 'failed' ? 'danger' : 'warning';
      const targetNames = (record.targets || []).map((target) => target.targetName).join(', ') || record.target || '—';
      const canRollback = (record.targets || []).some((target) => target.backup?.path);
      return '<tr><td>' + esc(dateText(record.finishedAt || record.createdAt)) + '</td><td><strong>' + esc(record.profileName || 'Profile') + '</strong></td><td><span class="tag ' + statusClass + '">' + esc(status.toUpperCase()) + '</span></td><td>' + esc(targetNames) + '</td><td>' + (record.durationMs ? esc(Math.round(record.durationMs / 1000)) + 's' : '—') + '</td><td>' + (canRollback ? '<button class="btn small" data-rollback="' + esc(record.id) + '">Rollback</button>' : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">No deployment history recorded yet.</td></tr>') +
    '</tbody></table></div></div>';
}

function renderLogs(root) {
  root.innerHTML = '<div class="card"><div class="card-header"><div><h3>Application log</h3><div class="card-subtitle">Passwords and private keys are never written to logs.</div></div><div class="flex"><input id="log-search" class="search-input" placeholder="Filter log text"><button class="btn small" id="copy-logs">Copy</button></div></div><div class="console" id="log-console" style="max-height:calc(100vh - 340px);min-height:250px;white-space:pre-wrap">' + esc(state.logs || 'No log entries found.') + '</div></div>';
}
function renderSettings(root) {
  root.innerHTML = '<div class="grid"><div class="span-6 card"><div class="card-header"><div><h3>Notifications</h3><div class="card-subtitle">Windows notifications after successful deployments.</div></div></div><label class="checkbox-row"><input id="setting-notifications" type="checkbox" ' + (state.settings.notifications !== false ? 'checked' : '') + '> Show desktop notifications</label><div class="section-divider"></div><label class="checkbox-row"><input id="setting-start-minimized" type="checkbox" ' + (state.settings.startMinimized ? 'checked' : '') + '> Start minimized to the system tray</label><div class="flex mt-16"><button class="btn primary" id="save-settings">Save settings</button></div></div><div class="span-6 card"><div class="card-header"><div><h3>Diagnostics</h3><div class="card-subtitle">Runtime and local storage details for support.</div></div></div><div class="field-label">CREDENTIAL STORAGE</div><p class="muted">Passwords, SSH private key material, and passphrases are encrypted with Windows safeStorage. Profile exports intentionally omit secrets.</p><div class="field-label mt-16">CONFIGURATION</div><p class="muted">DeployPilot uses atomic electron-store writes and keeps a previous configuration copy where available.</p><div class="flex mt-16"><button class="btn" id="copy-diagnostics">Copy diagnostics</button></div></div><div class="span-12 card"><div class="card-header"><div><h3>Keyboard shortcuts</h3><div class="card-subtitle">Global within the DeployPilot window.</div></div></div><div class="grid"><div class="span-4"><span class="tag">Ctrl + Enter</span><p class="muted">Publish active profile</p></div><div class="span-4"><span class="tag">Ctrl + N</span><p class="muted">Create new profile</p></div><div class="span-4"><span class="tag">Ctrl + ,</span><p class="muted">Open settings</p></div></div></div></div>';
}

function showModal(title, body, footer, eyebrow = 'PROJECT') {
  $('#modal-eyebrow').textContent = eyebrow;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-footer').innerHTML = footer;
  $('#modal').showModal();
}
function closeModal() {
  $('#modal').close();
  $('#modal-body').innerHTML = '';
  $('#modal-footer').innerHTML = '';
}

function profileForm(profile) {
  const p = profile || defaultProfile();
  const c = p.connection || {}, f = p.folders || {}, r = p.rules || {}, o = p.options || {};
  const targets = (p.targets || []).map((target) => [target.name, target.remotePath, target.localSubfolder || '', target.enabled !== false].join('|')).join('\n');
  const body = '<form id="profile-form"><div class="section-heading">PROFILE</div><div class="form-grid"><div class="form-field"><label>Project name *</label><input name="name" required value="' + esc(p.name) + '"></div><div class="form-field"><label>Accent color</label><input name="color" type="color" value="' + esc(p.color || '#14b8a6') + '"></div><div class="form-field full"><label>Description</label><input name="description" value="' + esc(p.description || '') + '" placeholder="What does this project deploy?"></div></div>' +
    '<div class="section-divider"></div><div class="section-heading">SERVER CONNECTION</div><div class="form-grid"><div class="form-field"><label>Protocol</label><select name="protocol"><option value="ftp">FTP</option><option value="ftps-explicit">FTPS · Explicit</option><option value="ftps-implicit">FTPS · Implicit</option><option value="sftp">SFTP</option></select></div><div class="form-field"><label>Host *</label><input name="host" required value="' + esc(c.host || '') + '" placeholder="ftp.example.com"></div><div class="form-field"><label>Port</label><input name="port" type="number" min="1" max="65535" value="' + esc(c.port || 21) + '"></div><div class="form-field"><label>Username *</label><input name="username" required value="' + esc(c.username || '') + '"></div><div class="form-field"><label>Password</label><input name="password" type="password" autocomplete="new-password" placeholder="Leave blank to keep saved password"></div><div class="form-field"><label>SSH passphrase</label><input name="passphrase" type="password" autocomplete="new-password" placeholder="SFTP key passphrase"></div><div class="form-field full"><label>SSH private key file (SFTP)</label><div class="input-with-button"><input name="privateKeyPath" id="private-key-path" readonly placeholder="Select a private key file"><button type="button" class="btn" id="pick-private-key">Choose key</button></div><div class="field-help">Private key contents are encrypted before storage. The selected path is not included in profile exports.</div></div><div class="form-field"><label>Timeout (ms)</label><input name="timeout" type="number" min="1000" max="300000" value="' + esc(c.timeout || 30000) + '"></div><div class="form-field"><label>Connection retries</label><input name="connectionRetries" type="number" min="0" max="8" value="' + esc(c.retries ?? 2) + '"></div></div><label class="checkbox-row mt-12"><input name="passive" type="checkbox" ' + (c.passive !== false ? 'checked' : '') + '> Passive mode (FTP/FTPS)</label>' +
    '<div class="section-divider"></div><div class="section-heading">LOCAL FOLDERS</div><div class="form-grid"><div class="form-field"><label>Project folder *</label><div class="input-with-button"><input name="projectFolder" id="project-folder" required readonly value="' + esc(f.projectFolder || '') + '"><button type="button" class="btn" id="pick-project">Browse</button></div></div><div class="form-field"><label>Backup folder</label><div class="input-with-button"><input name="backupFolder" id="backup-folder" readonly value="' + esc(f.backupFolder || '') + '"><button type="button" class="btn" id="pick-backup">Browse</button></div></div></div>' +
    '<div class="section-divider"></div><div class="section-heading">REMOTE TARGETS</div><div class="form-field"><label>One target per line: name | remote path | optional local subfolder | enabled</label><textarea name="targets" spellcheck="false" placeholder="Main | /var/www/site | dist | true\nSecondary | /var/www/staging | | false">' + esc(targets) + '</textarea><div class="field-help">Use absolute server paths below the account home. Empty paths, filesystem root, home roots, and parent traversal are rejected.</div></div>' +
    '<div class="section-divider"></div><div class="section-heading">RULES</div><div class="form-grid"><div class="form-field"><label>Upload exclude</label><textarea name="uploadExclude" spellcheck="false">' + esc(r.uploadExclude || '') + '</textarea></div><div class="form-field"><label>Backup exclude</label><textarea name="backupExclude" spellcheck="false">' + esc(r.backupExclude || '') + '</textarea></div><div class="form-field"><label>Protect on server</label><textarea name="protect" spellcheck="false">' + esc(r.protect || '') + '</textarea></div><div class="form-field"><label>Whitelist</label><textarea name="whitelist" spellcheck="false">' + esc(r.whitelist || '') + '</textarea><label class="checkbox-row"><input name="whitelistMode" type="checkbox" ' + (r.whitelistMode ? 'checked' : '') + '> Enable whitelist mode</label></div></div>' +
    '<div class="section-divider"></div><div class="section-heading">DEPLOYMENT OPTIONS</div><div class="form-grid"><div class="form-field"><label>Upload strategy</label><select name="strategy"><option value="staging">Staging swap (recommended)</option><option value="direct">Direct replace</option><option value="diff">Diff sync</option></select></div><div class="form-field"><label>Concurrency (SFTP: 1–8; FTP is serialized)</label><input name="concurrency" type="number" min="1" max="8" value="' + esc(o.concurrency || 4) + '"></div><div class="form-field"><label>Retry attempts</label><input name="retries" type="number" min="0" max="8" value="' + esc(o.retries ?? 2) + '"></div><div class="form-field"><label>Timeout (ms)</label><input name="optionTimeout" type="number" min="1000" max="300000" value="' + esc(o.timeout || 30000) + '"></div><div class="form-field"><label>Backup retention</label><input name="retention" type="number" min="1" max="500" value="' + esc(o.retention || 10) + '"></div><div class="form-field"><label>Maintenance mode file (optional)</label><input name="maintenanceFile" value="' + esc(o.maintenanceFile || '') + '" placeholder="maintenance.flag"></div></div><div class="flex wrap mt-12"><label class="checkbox-row"><input name="backup" type="checkbox" ' + (o.backup !== false ? 'checked' : '') + '> Backup before deploy</label><label class="checkbox-row"><input name="abortOnBackupFailure" type="checkbox" ' + (o.abortOnBackupFailure !== false ? 'checked' : '') + '> Abort if backup fails</label><label class="checkbox-row"><input name="deleteRemoved" type="checkbox" ' + (o.deleteRemoved ? 'checked' : '') + '> Delete removed files (diff)</label><label class="checkbox-row"><input name="chmod" type="checkbox" ' + (o.chmod ? 'checked' : '') + '> Apply chmod 644 / 755</label></div>' +
    '<div class="section-divider"></div><div class="section-heading">SHELL HOOKS</div><div class="form-grid"><div class="form-field"><label>Pre-deploy command</label><textarea name="preDeploy" spellcheck="false">' + esc(p.hooks?.preDeploy || '') + '</textarea></div><div class="form-field"><label>Post-deploy command</label><textarea name="postDeploy" spellcheck="false">' + esc(p.hooks?.postDeploy || '') + '</textarea></div></div>' +
    '<div class="section-divider"></div><label class="checkbox-row"><input name="isProduction" type="checkbox" ' + (p.isProduction ? 'checked' : '') + '> Production profile · require typing the project name before publishing</label><input type="hidden" name="id" value="' + esc(p.id) + '"></form>';
  showModal(profile ? 'Edit profile' : 'Create profile', body, '<button class="btn" id="cancel-profile">Cancel</button><button class="btn primary" id="save-profile">Save profile</button>');
  const form = $('#profile-form');
  $('select[name="protocol"]', form).value = c.protocol || 'ftp';
  $('select[name="strategy"]', form).value = o.strategy || 'staging';
  $('select[name="protocol"]', form).addEventListener('change', (event) => {
    const port = $('input[name="port"]', form);
    if (event.target.value === 'sftp' && Number(port.value) === 21) port.value = '22';
    else if (event.target.value === 'ftps-implicit' && [21, 22].includes(Number(port.value))) port.value = '990';
    else if (event.target.value === 'ftp' && [22, 990].includes(Number(port.value))) port.value = '21';
  });
  $('#pick-project').addEventListener('click', async () => {
    const picked = await api.files.pickFolder('Select project folder');
    if (picked) $('#project-folder').value = picked;
  });
  $('#pick-backup').addEventListener('click', async () => {
    const picked = await api.files.pickFolder('Select backup folder');
    if (picked) $('#backup-folder').value = picked;
  });
  $('#pick-private-key').addEventListener('click', async () => {
    const picked = await api.files.pickPrivateKey();
    if (picked) $('#private-key-path').value = picked;
  });
  $('#cancel-profile').addEventListener('click', closeModal);
  $('#save-profile').addEventListener('click', saveProfileForm);
}

async function saveProfileForm() {
  const form = $('#profile-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const id = data.get('id');
  const old = state.profiles.find((row) => row.id === id) || defaultProfile();
  const targets = String(data.get('targets') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('|').map((part) => part.trim());
    const previous = (old.targets || []).find((target) => target.name === (parts[0] || 'Target'));
    return { id: previous?.id || uuid(), name: parts[0] || 'Target', remotePath: parts[1] || '', localSubfolder: parts[2] || '', enabled: parts[3] === undefined ? true : !['false', '0', 'off', 'no'].includes(parts[3].toLowerCase()) };
  });
  const bool = (name) => data.get(name) === 'on';
  const profile = {
    ...old, id, name: String(data.get('name')).trim(), color: data.get('color'), description: data.get('description'),
    connection: { ...old.connection, protocol: data.get('protocol'), host: data.get('host'), port: Number(data.get('port')), username: data.get('username'), passive: bool('passive'), timeout: Number(data.get('timeout')), retries: Number(data.get('connectionRetries')) },
    folders: { projectFolder: data.get('projectFolder'), backupFolder: data.get('backupFolder') },
    targets,
    rules: { uploadExclude: data.get('uploadExclude'), backupExclude: data.get('backupExclude'), protect: data.get('protect'), whitelist: data.get('whitelist'), whitelistMode: bool('whitelistMode') },
    options: { ...old.options, backup: bool('backup'), abortOnBackupFailure: bool('abortOnBackupFailure'), strategy: data.get('strategy'), deleteRemoved: bool('deleteRemoved'), concurrency: Number(data.get('concurrency')), retries: Number(data.get('retries')), timeout: Number(data.get('optionTimeout')), chmod: bool('chmod'), maintenanceFile: data.get('maintenanceFile'), retention: Number(data.get('retention')) },
    hooks: { preDeploy: data.get('preDeploy'), postDeploy: data.get('postDeploy') }, isProduction: bool('isProduction')
  };
  const credentials = {};
  if (String(data.get('password') || '')) credentials.password = data.get('password');
  if (String(data.get('passphrase') || '')) credentials.passphrase = data.get('passphrase');
  if ($('#private-key-path').value) credentials.privateKeyPath = $('#private-key-path').value;
  try {
    const saved = await api.profiles.save(profile, credentials);
    state.activeId = saved.id;
    await loadData();
    closeModal();
    toast('Profile saved. Credentials are encrypted locally.');
    render();
  } catch (error) { toast(error.message, 'error'); }
}

function renderDeployEvents() {
  const consoleNode = $('#deploy-console');
  if (!consoleNode) return;
  const steps = { validate: 'validate', connection: 'connect', preDeploy: 'predeploy', scan: 'scan', backup: 'backup', plan: 'upload', upload: 'upload', postDeploy: 'postdeploy', history: 'history', complete: 'history' };
  const lines = state.events.slice(-150).map((event) => {
    const label = event.status === 'error' ? 'ERROR' : event.status === 'success' ? 'OK' : 'INFO';
    const detail = event.message || event.file || event.target || (event.uploaded !== undefined ? 'Uploaded ' + event.uploaded + ', deleted ' + event.deleted + ', skipped ' + event.skipped : event.status);
    return '<div class="console-line"><span class="console-time">' + esc(new Date(event.at || Date.now()).toLocaleTimeString()) + '</span><span class="console-level">' + label + '</span><span class="console-message">' + esc(event.step + ': ' + detail) + '</span></div>';
  }).join('');
  consoleNode.innerHTML = lines || '<div class="muted">Waiting for deployment updates…</div>';
  consoleNode.scrollTop = consoleNode.scrollHeight;
  for (const event of state.events) {
    const key = steps[event.step];
    if (!key) continue;
    const node = $('[data-step="' + key + '"]');
    if (!node) continue;
    if (event.status === 'success' || event.status === 'skipped') {
      node.className = 'step success';
      $('.step-state', node).textContent = event.status === 'skipped' ? 'Skipped' : 'Complete';
    } else if (event.status === 'running' || event.status === 'progress') {
      node.className = 'step running';
      $('.step-state', node).textContent = event.status === 'progress' ? 'Working' : 'In progress';
    } else if (event.status === 'error') {
      node.className = 'step error';
      $('.step-state', node).textContent = 'Failed';
    }
    if (event.percent !== undefined) {
      $('#deploy-progress').style.width = event.percent + '%';
      $('#deploy-percent').textContent = event.percent + '%';
    }
    if (event.target) {
      const detail = [event.file, event.speedBps ? speedText(event.speedBps) : '', event.etaSeconds !== null && event.etaSeconds !== undefined ? 'ETA ' + event.etaSeconds + 's' : ''].filter(Boolean).join(' · ');
      $('#deploy-message').textContent = event.target + ' · ' + (detail || event.status);
    }
  }
}

function showDeployResult(result) {
  const output = $('#plan-output');
  if (!output || !result) return;
  if (result.targets?.length) {
    output.innerHTML = '<div class="section-divider"></div><div class="section-heading">' + (result.status === 'dry-run' ? 'DRY-RUN PLAN' : 'DEPLOYMENT SUMMARY') + '</div>' + result.targets.map((target) => '<div class="flex between wrap mt-12"><strong>' + esc(target.targetName) + '</strong><span class="muted">' + target.plan.uploads.length + ' upload · ' + target.plan.deletions.length + ' delete · ' + target.plan.skipped.length + ' skipped</span></div><div class="console mt-12">' + esc([...target.plan.uploads.map((file) => 'UPLOAD  ' + file.path), ...target.plan.deletions.map((file) => 'DELETE  ' + file.path), ...(target.backupPlan || []).map((file) => 'BACKUP  ' + file), ...target.plan.skipped.map((file) => 'SKIP    ' + file.path + ' (' + file.reason + ')')].join('\n') || 'No file changes.') + '</div>').join('');
  } else output.textContent = result.error || '';
  if (result.status === 'success') {
    $('#deploy-progress').style.width = '100%';
    $('#deploy-percent').textContent = '100%';
    $('#deploy-message').textContent = 'Deployment completed in ' + Math.round((result.durationMs || 0) / 1000) + ' seconds.';
  }
}

async function startDeploy() {
  const profile = activeProfile();
  if (!profile) return toast('Create or select a profile first.', 'error');
  const dryRun = $('#dry-run')?.checked || false;
  const summary = 'Profile: ' + profile.name + '\nTargets: ' + profile.targets.filter((target) => target.enabled).map((target) => target.name + ' → ' + target.remotePath).join('\n') + '\nStrategy: ' + (profile.options.strategy || 'staging') + '\nBackup: ' + (profile.options.backup ? 'On' : 'Off') + (dryRun ? '\nMode: Dry run (no remote changes)' : '');
  if (!window.confirm(summary + '\n\nContinue?')) return;
  let confirmName = '';
  if (profile.isProduction && !dryRun) {
    confirmName = window.prompt('Production deployment. Type the exact project name to continue:') || '';
    if (confirmName !== profile.name) return toast('Production confirmation did not match.', 'error');
  }
  state.events = [];
  state.deployResult = null;
  state.jobId = 'starting';
  renderDeployEvents();
  setStatus('Deployment running', 'Working');
  try {
    const result = await api.deploy.start(profile.id, { confirmed: true, confirmName, dryRun });
    state.jobId = result.jobId;
    $('#cancel-deploy').disabled = false;
    toast(dryRun ? 'Dry run started.' : 'Deployment started.');
  } catch (error) {
    state.jobId = null;
    toast(error.message, 'error');
  }
}

async function loadBackups() {
  const profile = activeProfile();
  state.backups = profile ? await api.backups.list(profile.id) : [];
}
async function loadData() {
  state.profiles = await api.profiles.list();
  if (!state.activeId || !state.profiles.some((profile) => profile.id === state.activeId)) state.activeId = state.profiles[0]?.id || null;
  state.history = await api.history.list();
  state.settings = await api.settings.get();
  await loadBackups();
}

async function browseRemote(targetId) {
  const profile = activeProfile();
  const target = profile?.targets.find((row) => row.id === targetId);
  if (!target) return;
  let current = target.remotePath;
  showModal('Remote folder browser', '<div class="field-help">Read-only server browser. Choose a directory and apply its path to this target.</div><div class="flex mt-12"><input id="remote-current" value="' + esc(current) + '"><button class="btn" id="remote-go">Open</button></div><div class="remote-list" id="remote-entries"></div>', '<button class="btn" id="remote-cancel">Cancel</button><button class="btn primary" id="remote-use">Use this path</button>', 'REMOTE BROWSER');
  const load = async (remotePath) => {
    try {
      const rows = await api.connection.listRemote(profile.id, remotePath);
      current = remotePath;
      $('#remote-current').value = current;
      $('#remote-entries').innerHTML = '<div class="remote-entry"><span>📁 ..</span><button class="btn small" id="remote-up">Up</button></div>' + rows.filter((row) => row.isDirectory).map((row) => '<div class="remote-entry"><span>📁 ' + esc(row.name) + '</span><button class="btn small" data-remote-open="' + esc(row.path) + '">Open</button></div>').join('') + rows.filter((row) => !row.isDirectory).map((row) => '<div class="remote-entry"><span>▤ ' + esc(row.name) + '</span><span class="muted">' + esc(row.size) + ' bytes</span></div>').join('');
      $('#remote-up').addEventListener('click', () => {
        const parts = current.split('/').filter(Boolean);
        parts.pop();
        if (parts.length > 1) load('/' + parts.join('/'));
      });
      $$('[data-remote-open]').forEach((button) => button.addEventListener('click', () => load(button.dataset.remoteOpen)));
    } catch (error) { toast(error.message, 'error'); }
  };
  $('#remote-go').addEventListener('click', () => load($('#remote-current').value));
  $('#remote-cancel').addEventListener('click', closeModal);
  $('#remote-use').addEventListener('click', async () => {
    target.remotePath = current;
    await api.profiles.save(profile, {});
    await loadData();
    closeModal();
    render();
    toast('Remote target path updated.');
  });
  await load(current);
}

async function saveRules() {
  const profile = activeProfile();
  if (!profile) return;
  profile.rules = {
    uploadExclude: $('#rule-upload').value,
    backupExclude: $('#rule-backup').value,
    protect: $('#rule-protect').value,
    whitelist: $('#rule-whitelist').value,
    whitelistMode: $('#rule-whitelist-mode').checked
  };
  await api.profiles.save(profile, {});
  await loadData();
  render();
  toast('Rules saved.');
}

async function testRule() {
  const relativePath = $('#rule-test-path').value.trim();
  state.rulePath = relativePath;
  const rules = {
    uploadExclude: $('#rule-upload').value,
    protect: $('#rule-protect').value,
    whitelist: $('#rule-whitelist').value,
    whitelistMode: $('#rule-whitelist-mode').checked
  };
  try {
    const result = await api.rules.test(rules, relativePath);
    $('#rule-result').textContent = 'Path: ' + relativePath + ' → ' + result.action.toUpperCase() + ' · ' + result.reason;
  } catch (error) {
    $('#rule-result').textContent = error.message;
    toast(error.message, 'error');
  }
}

function attachHandlers() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', async () => {
    state.page = button.dataset.page;
    if (state.page === 'backups') await loadBackups();
    if (state.page === 'history') state.history = await api.history.list();
    if (state.page === 'logs') state.logs = await api.logs.read();
    render();
  }));
  $('#window-minimize').addEventListener('click', () => api.app.minimize());
  $('#window-maximize').addEventListener('click', () => api.app.toggleMaximize());
  $('#window-close').addEventListener('click', () => api.app.close());
  $('#modal-close').addEventListener('click', closeModal);

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.id === 'new-profile' || button.id === 'empty-new-profile') profileForm(null);
      if (button.id === 'edit-active' || button.id === 'edit-targets') {
        const profile = activeProfile();
        if (profile) profileForm(profile);
      }
      if (button.dataset.edit) profileForm(state.profiles.find((profile) => profile.id === button.dataset.edit));
      if (button.dataset.deploy) { state.activeId = button.dataset.deploy; state.page = 'deploy'; render(); }
      if (button.dataset.more) {
        const profile = state.profiles.find((row) => row.id === button.dataset.more);
        const action = window.prompt('Type: duplicate, export, or delete');
        if (action === 'duplicate') {
          await api.profiles.duplicate(profile.id);
          await loadData(); render(); toast('Profile duplicated.');
        } else if (action === 'export') await api.profiles.export([profile.id]);
        else if (action === 'delete' && window.confirm('Delete profile ' + profile.name + '?')) {
          await api.profiles.delete(profile.id, true);
          if (state.activeId === profile.id) state.activeId = null;
          await loadData(); render(); toast('Profile deleted.');
        }
      }
      if (button.id === 'import-profiles') {
        const result = await api.profiles.import();
        if (!result.canceled) { await loadData(); render(); toast(result.profiles.length + ' profile(s) imported. Secrets are not included in profile files.'); }
      }
      if (button.id === 'export-profiles') {
        const result = await api.profiles.export([]);
        if (!result.canceled) toast('Profiles exported without credentials.');
      }
      if (button.id === 'publish-top' || button.id === 'publish-main') await startDeploy();
      if (button.id === 'test-connection') {
        button.disabled = true; button.textContent = 'Testing…';
        try { const result = await api.connection.test(state.activeId); toast(result.message); }
        catch (error) { toast(error.message, 'error'); }
        finally { button.disabled = false; button.textContent = '◎ Test connection'; }
      }
      if (button.id === 'cancel-deploy' && state.jobId && state.jobId !== 'starting') await api.deploy.cancel(state.jobId);
      if (button.dataset.browse) await browseRemote(button.dataset.browse);
      if (button.id === 'refresh-backups') { await loadBackups(); render(); }
      if (button.dataset.verify) {
        const result = await api.backups.verify(state.activeId, button.dataset.verify);
        toast(result.valid ? 'Backup ZIP verified successfully.' : 'Backup verification failed.', result.valid ? 'success' : 'error');
      }
      if (button.dataset.deleteBackup) {
        if (!window.confirm('Permanently delete this backup ZIP and its manifest?')) return;
        await api.backups.delete(state.activeId, button.dataset.deleteBackup, true);
        await loadBackups(); render(); toast('Backup deleted.');
      }
      if (button.dataset.openBackup) await api.files.openPath(button.dataset.openBackup);
      if (button.dataset.restore) {
        const backup = state.backups.find((row) => row.id === button.dataset.restore);
        if (!backup || !window.confirm('Restore this snapshot? DeployPilot will first take a safety backup.')) return;
        const result = await api.backups.restore(state.activeId, backup, true);
        toast('Rollback completed. ' + result.uploaded + ' files restored.');
        await loadBackups(); state.history = await api.history.list(); render();
      }
      if (button.id === 'refresh-history') { state.history = await api.history.list(); render(); }
      if (button.dataset.rollback) {
        const record = state.history.find((row) => row.id === button.dataset.rollback);
        const target = record?.targets?.find((row) => row.backup?.path);
        if (!target) return;
        const profile = state.profiles.find((row) => row.id === record.profileId);
        if (!profile) return toast('The source profile no longer exists.', 'error');
        state.activeId = profile.id;
        if (!window.confirm('Roll back ' + target.targetName + '? A new safety backup will be taken first.')) return;
        await api.backups.restore(profile.id, target.backup, true);
        toast('Rollback completed.');
        await loadData(); render();
      }
      if (button.id === 'save-rules') await saveRules();
      if (button.id === 'test-rule') await testRule();
      if (button.id === 'copy-diagnostics') {
        await navigator.clipboard.writeText(await api.logs.diagnostics());
        toast('Diagnostics copied to clipboard.');
      }
      if (button.id === 'copy-logs') { await navigator.clipboard.writeText(state.logs); toast('Application log copied.'); }
      if (button.id === 'refresh-logs') { state.logs = await api.logs.read(); render(); }
      if (button.id === 'save-settings') {
        state.settings = await api.settings.save({
          notifications: $('#setting-notifications').checked,
          startMinimized: $('#setting-start-minimized').checked
        });
        toast('Settings saved.');
      }
    } catch (error) { toast(error.message || String(error), 'error'); }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'deploy-profile') {
      state.activeId = event.target.value;
      loadBackups().then(render);
    }
    if (event.target.id === 'rule-preset' && event.target.value) {
      const presets = {
        PHP: 'vendor/\nnode_modules/\n.git/\n.env\n.env.*\n*.log',
        Laravel: 'vendor/\nnode_modules/\n.git/\n.env\nstorage/logs/\nstorage/framework/cache/',
        WordPress: 'wp-content/cache/\nwp-content/upgrade/\nwp-config.php\n.git/',
        Node: 'node_modules/\n.git/\n.env\n.env.*\ncoverage/\n*.log',
        Static: '.git/\n.DS_Store\n*.map',
        ReactVue: 'node_modules/\n.git/\n.env\n.env.*\ncoverage/'
      };
      $('#rule-upload').value = presets[event.target.value] || '';
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'log-search') {
      const query = event.target.value.toLowerCase();
      $('#log-console').textContent = state.logs.split('\n').filter((line) => line.toLowerCase().includes(query)).join('\n') || 'No matching log entries.';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'Enter') { event.preventDefault(); if (state.page === 'deploy') startDeploy(); }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); profileForm(null); }
    if (event.key === ',') { event.preventDefault(); state.page = 'settings'; render(); }
  });
}

function handleDeployProgress(event) {
  if (event.jobId && state.jobId && event.jobId !== state.jobId) return;
  state.events.push(event);
  renderDeployEvents();
  if (event.status === 'running') setStatus('Deployment running', event.step);
}
async function handleDeployFinished(event) {
  if (event.jobId && state.jobId && event.jobId !== state.jobId) return;
  state.jobId = null;
  state.deployResult = event.result;
  state.history = await api.history.list();
  renderDeployEvents();
  showDeployResult(event.result);
  if ($('#cancel-deploy')) $('#cancel-deploy').disabled = true;
  setStatus('Deployment complete', 'Idle');
  toast(event.result.status === 'dry-run' ? 'Dry run completed.' : 'Deployment completed successfully.');
  loadBackups().catch(() => {});
}
async function handleDeployError(event) {
  if (event.jobId && state.jobId && event.jobId !== state.jobId) return;
  state.jobId = null;
  if ($('#cancel-deploy')) $('#cancel-deploy').disabled = true;
  state.events.push({ step: 'complete', status: 'error', message: event.message, at: new Date().toISOString() });
  renderDeployEvents();
  setStatus('Deployment failed', 'Idle');
  toast(event.message, 'error');
  state.history = await api.history.list();
}

async function boot() {
  attachHandlers();
  api.deploy.onProgress(handleDeployProgress);
  api.deploy.onFinished(handleDeployFinished);
  api.deploy.onError(handleDeployError);
  try {
    const version = await api.app.getVersion();
    $('#app-version').textContent = version;
    await loadData();
  } catch (error) { toast(error.message, 'error'); }
  render();
}
boot();
