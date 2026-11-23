import ignore from 'ignore';

function matcher(text) {
  const engine = ignore({ allowRelativePaths: true });
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trimEnd());
  engine.add(lines.filter((line) => line.trim() && !line.trimStart().startsWith('#')));
  return (relativePath, isDirectory = false) => {
    const value = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!value) return false;
    const candidate = isDirectory && !value.endsWith('/') ? value + '/' : value;
    return engine.ignores(candidate);
  };
}

export function evaluateUploadPath(relativePath, rules, isDirectory = false) {
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const protect = matcher(rules?.protect);
  if (protect(rel, isDirectory)) return { action: 'protected', reason: 'Protected on server' };
  if (matcher(rules?.uploadExclude)(rel, isDirectory)) return { action: 'skip', reason: 'Upload exclude' };
  if (rules?.whitelistMode && String(rules?.whitelist || '').trim() && !matcher(rules.whitelist)(rel, isDirectory)) {
    return { action: 'skip', reason: 'Not in whitelist' };
  }
  return { action: 'include', reason: 'Included' };
}

export function evaluateBackupPath(relativePath, rules, isDirectory = false) {
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (matcher(rules?.backupExclude)(rel, isDirectory)) return { action: 'skip', reason: 'Backup exclude' };
  return { action: 'include', reason: 'Included in backup' };
}

export function isProtectedPath(relativePath, rules, isDirectory = false) {
  return matcher(rules?.protect)(relativePath, isDirectory);
}

export const RULE_PRESETS = {
  PHP: 'vendor/\\nnode_modules/\\n.git/\\n.env\\n.env.*\\n*.log\\n',
  Laravel: 'vendor/\\nnode_modules/\\n.git/\\n.env\\nstorage/logs/\\nstorage/framework/cache/\\n',
  WordPress: 'wp-content/cache/\\nwp-content/upgrade/\\nwp-config.php\\n.git/\\n',
  Node: 'node_modules/\\n.git/\\n.env\\n.env.*\\ncoverage/\\n*.log\\n',
  Static: '.git/\\n.DS_Store\\n*.map\\n',
  ReactVue: 'node_modules/\\n.git/\\n.env\\n.env.*\\ncoverage/\\n'
};
