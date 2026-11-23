const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('deployPilot', Object.freeze({
  app: Object.freeze({
    minimize: invoke('app:minimize'),
    toggleMaximize: invoke('app:toggle-maximize'),
    close: invoke('app:close'),
    getVersion: invoke('app:version')
  }),
  profiles: Object.freeze({
    list: invoke('profiles:list'),
    get: invoke('profiles:get'),
    save: invoke('profiles:save'),
    duplicate: invoke('profiles:duplicate'),
    delete: invoke('profiles:delete'),
    import: invoke('profiles:import'),
    export: invoke('profiles:export')
  }),
  files: Object.freeze({
    pickFolder: invoke('files:pick-folder'),
    pickPrivateKey: invoke('files:pick-private-key'),
    openPath: invoke('files:open-path')
  }),
  connection: Object.freeze({
    test: invoke('connection:test'),
    listRemote: invoke('connection:list-remote')
  }),
  deploy: Object.freeze({
    start: invoke('deploy:start'),
    cancel: invoke('deploy:cancel'),
    onProgress: subscribe('deploy:progress'),
    onFinished: subscribe('deploy:finished'),
    onError: subscribe('deploy:error')
  }),
  backups: Object.freeze({
    list: invoke('backups:list'),
    verify: invoke('backups:verify'),
    delete: invoke('backups:delete'),
    restore: invoke('backups:restore')
  }),
  rules: Object.freeze({ test: invoke('rules:test') }),
  history: Object.freeze({ list: invoke('history:list') }),
  logs: Object.freeze({ read: invoke('logs:read'), diagnostics: invoke('logs:diagnostics') }),
  settings: Object.freeze({ get: invoke('settings:get'), save: invoke('settings:save') })
}));
