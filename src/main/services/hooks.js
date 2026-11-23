import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function runHook(command, cwd, context = {}) {
  if (!String(command || '').trim()) return { skipped: true };
  const env = {
    ...process.env,
    DEPLOYPILOT_PROFILE: String(context.profileName || ''),
    DEPLOYPILOT_TARGET: String(context.targetName || '')
  };
  const result = await execAsync(command, {
    cwd,
    env,
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
