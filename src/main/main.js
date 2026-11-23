import { app, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { createMainWindow } from './window.js';
import { getSettings } from './services/profileStore.js';
import { registerIpc } from './ipc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let tray;
let mainWindow;

log.initialize();
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level = 'warn';

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    mainWindow = createMainWindow({ showOnReady: !getSettings().startMinimized });
    const icon = nativeImage.createFromPath(path.join(here, '../../build/icon.ico'));
    tray = new Tray(icon);
    tray.setToolTip('DeployPilot');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open DeployPilot', click: () => mainWindow?.show() },
      { label: 'Quit', click: () => app.quit() }
    ]));
    tray.on('double-click', () => mainWindow?.show());
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
      else mainWindow.show();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    log.info('DeployPilot started.');
  }).catch((error) => {
    log.error('Application startup failed:', error);
    if (Notification.isSupported()) new Notification({ title: 'DeployPilot error', body: error.message }).show();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  tray?.destroy();
});
