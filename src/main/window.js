import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow({ showOnReady = true } = {}) {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#0b1112',
    title: 'DeployPilot',
    webPreferences: {
      preload: path.join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  window.removeMenu();
  window.once('ready-to-show', () => { if (showOnReady) window.show(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.loadFile(path.join(here, '../renderer/index.html'));
  return window;
}
