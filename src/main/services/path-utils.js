import path from 'node:path';

export function normalizeRemotePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Remote path is required.');
  const raw = input.trim().replace(/\\/g, '/');
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('$HOME')) {
    throw new Error('Use an absolute server path below the account home directory, not a home alias.');
  }
  if (/[\0\r\n]/.test(raw)) throw new Error('Remote paths cannot contain control characters.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Remote paths cannot contain dot segments.');
  const normalized = path.posix.normalize(raw.startsWith('/') ? raw : '/' + raw);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function assertSafeRemotePath(input) {
  const remote = normalizeRemotePath(input);
  if (remote === '/') throw new Error('The server root is not a valid deployment target.');
  const parts = remote.split('/').filter(Boolean);
  const homeRoots = [/^home$/i, /^users?$/i, /^root$/i, /^private$/i, /^export$/i];
  if (parts.length === 1 && homeRoots.some((pattern) => pattern.test(parts[0]))) {
    throw new Error('A filesystem or home root cannot be used as a deployment target.');
  }
  if (parts.length === 2 && (/^home$/i.test(parts[0]) || /^users?$/i.test(parts[0]))) {
    throw new Error('A user home directory cannot be used as a deployment target. Choose a child folder.');
  }
  return remote;
}

export function assertRemoteWithin(root, candidate) {
  const safeRoot = assertSafeRemotePath(root);
  const safeCandidate = normalizeRemotePath(candidate);
  if (safeCandidate !== safeRoot && !safeCandidate.startsWith(safeRoot + '/')) {
    throw new Error('Refusing a remote operation outside the configured target path.');
  }
  return safeCandidate;
}

export function assertRemoteSibling(parent, candidate) {
  const safeParent = normalizeRemotePath(parent);
  if (safeParent === '/') throw new Error('Refusing a staging operation directly under the server root.');
  const safeCandidate = normalizeRemotePath(candidate);
  if (path.posix.dirname(safeCandidate) !== safeParent) {
    throw new Error('Refusing a remote operation outside the deployment staging area.');
  }
  return safeCandidate;
}

export function remoteJoin(root, relative) {
  const safeRoot = assertSafeRemotePath(root);
  const rel = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.split('/').some((part) => part === '..' || part === '.')) throw new Error('Unsafe relative path.');
  const result = path.posix.join(safeRoot, rel);
  return assertRemoteWithin(safeRoot, result);
}

export function isWithinLocal(root, candidate) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}
