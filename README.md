# DeployPilot

[![CI](https://github.com/notmohammadxm/deploypilot/actions/workflows/ci.yml/badge.svg)](https://github.com/notmohammadxm/deploypilot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/notmohammadxm/deploypilot)](https://github.com/notmohammadxm/deploypilot/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)

DeployPilot is a Windows desktop deployment utility for profile-based FTP, FTPS, and SFTP publishing. It backs up each enabled remote target before deployment, applies independent path rules, supports staging swap and diff upload strategies, records history, and can restore verified snapshots.

## Features

- **Profiles:** independent server credentials, project/backup folders, one or more remote targets, rules, hooks, and deployment options.
- **Protocols:** FTP, explicit FTPS, implicit FTPS, and SFTP with password or encrypted SSH private key credentials.
- **Backups:** recursive remote download, ZIP archive, sidecar manifest.json, extraction verification, and per-target retention.
- **Deployment:** staging swap (default), direct replace, or diff sync based on size and modification time.
- **Safety:** absolute remote target validation, root/home-root rejection, scoped destructive operations, server-protect rules, explicit confirmation, and a safety backup before rollback.
- **Rules:** gitignore syntax for upload exclusions, backup exclusions, protected remote files, and optional whitelist mode.
- **Operations:** dry-run plan, hooks, retry backoff, deployment history, logs, diagnostics copy, read-only remote browser, and Windows notifications.

## Requirements

- Windows 10 or 11
- Node.js 20 for linting and unit tests. The current Electron release line requires Node.js 22.12+ on the packaging host and bundles its own newer Node.js runtime; use Node 22.12+ for `npm run dist`.
- A reachable FTP/FTPS/SFTP server and credentials
- A local project directory and a separate local backup directory (recommended)

## Install and run from source

~~~powershell
git clone https://github.com/notmohammadxm/deploypilot.git
cd deploypilot
npm install
npm start
~~~

Build the assisted Windows NSIS installer:

~~~powershell
npm run dist
~~~

The installer is written to dist/DeployPilot-Setup-1.0.0.exe for version 1.0.0. It allows installation-directory selection and creates Desktop and Start Menu shortcuts.

## First deployment tutorial

1. Open **Projects → New profile** and enter a project name.
2. Choose FTP, FTPS Explicit, FTPS Implicit, or SFTP. Enter host, port, username, and credentials. For SFTP key authentication, choose the private key file and optionally enter its passphrase.
3. Choose the local project folder and a separate backup folder.
4. Add targets. Use an absolute server path below the account home, for example /home/deploy/public_html. Do not enter /, /home/deploy, or another home/filesystem root.
5. Configure rules. Add paths such as node_modules/, .git/, and .env to Upload Exclude. Add user-uploaded server paths such as uploads/ to Protect on server.
6. Press **Test connection**. Use the read-only **Browse** action to inspect the remote folder structure and choose a target path.
7. Run a **Dry run** to inspect uploads, protected/skipped files, and diff deletions. Dry run does not run shell hooks or change remote files.
8. Publish. DeployPilot validates the profile, connects, runs the pre-deploy hook, scans local files, creates and verifies each target backup, applies the upload strategy, runs the post-deploy hook, and stores history.
9. To roll back, open **Backups** or **History** and select a snapshot. DeployPilot takes a fresh safety backup before restoring it.

## Rule syntax and precedence

Patterns use gitignore syntax (one pattern per line). Blank lines and lines beginning with # are ignored. A trailing slash matches directories; *, **, and ? are supported by the ignore engine. Rules are evaluated relative to the project folder for uploads and relative to the configured remote target for backup/protect checks.

Precedence is:

1. **Protect on server:** never overwrite or delete a matching remote path. Staging deployment copies protected remote files into the new staged tree before swap.
2. **Upload Exclude:** never upload a matching local path.
3. **Whitelist:** when enabled and non-empty, only matching paths can be uploaded.
4. **Default include:** paths not matched by earlier rules are eligible.

Upload Exclude does not automatically mean Protect on server. Use Protect on server for content maintained by the live application, such as customer uploads.

## Deployment strategies

- **Staging swap:** upload into a sibling .__deploy_tmp__ folder, preserve protected server files, rename the current target to .__old__, move the new tree into place, and remove the old tree. If the second rename fails, the previous target is restored.
- **Direct replace:** upload eligible files over the existing remote target; no remote cleanup is performed.
- **Diff sync:** upload changed files using size and modification time; optionally delete remote-only files, excluding protected paths.

FTP operations are serialized on the FTP connection. SFTP transfers use the configured concurrency (1–8). Retry attempts use exponential backoff.

## Credential and data handling

Credentials and SSH private key contents are encrypted by Electron safeStorage before they are persisted. Profile export/import intentionally excludes passwords, passphrases, private key data, and private key paths. Credentials are not written to application logs. Application profiles and history remain on the local machine in Electron user data.

## Architecture

~~~mermaid
flowchart LR
  UI[Vanilla JS renderer] -->|allowlisted IPC| PRE[Context-isolated preload]
  PRE --> MAIN[Electron main process]
  MAIN --> STORE[Profiles and encrypted secrets]
  MAIN --> CONN[FTP / FTPS / SFTP adapters]
  MAIN --> PIPE[Deployment pipeline]
  PIPE --> SCAN[Scanner and rules]
  PIPE --> BACKUP[Remote backup and ZIP verify]
  PIPE --> UP[Staging / direct / diff uploader]
  PIPE --> HIST[History and rollback]
  CONN --> SERVER[(Remote server)]
  BACKUP --> LOCAL[(Local backup folder)]
~~~

## Tests and CI

Run checks locally:

~~~powershell
npm run lint
npm test
~~~

GitHub Actions runs ESLint, unit tests, and a dependency security audit on windows-latest with Node.js 20. After a successful push to main, the Windows workflow builds the NSIS installer and uploads `DeployPilot-Windows-Installer` as a 30-day Actions artifact. Pushing a version tag such as `v1.0.0` builds and publishes the matching `DeployPilot-Setup-<version>.exe` and its SHA-256 checksum to GitHub Releases.

## Known limitations

- FTP/FTPS servers differ in support for SITE CHMOD, timestamps, and recursive remove operations. chmod is best-effort and server dependent.
- Diff sync relies on file size and modification time, not remote content hashes.
- The built-in FTP client uses passive data connections; the passive-mode option is retained in the profile for compatibility.
- The configured maintenance-mode filename is stored in the profile UI; automatic server maintenance-file orchestration is not yet part of this release. Transfer speed and ETA are estimates updated after each completed file.
- ZIP verification checks entry sizes and safe relative paths, rejects symbolic links and special files, and confirms extraction succeeds; it is not an end-to-end remote content hash verification.
- SSH key support reads the selected key file at profile-save time. Re-select the key after moving or rotating it.

## License

MIT. See LICENSE.
