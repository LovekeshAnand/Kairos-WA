const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kairos', {
  open: (p) => ipcRenderer.invoke('kairos:open', p),
  reveal: (p) => ipcRenderer.invoke('kairos:reveal', p),
  external: (url) => ipcRenderer.invoke('kairos:external', url),
  loginItem: (on) => ipcRenderer.invoke('kairos:loginItem', on),
});
