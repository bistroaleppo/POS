'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bistroPrint', {
  isElectron: true,
  printRaw: (job) => ipcRenderer.invoke('print:raw', job),
  listPrinters: () => ipcRenderer.invoke('print:list'),
  printSilent: (opts) => ipcRenderer.invoke('print:silent', opts),
  printWindowsRaw: (job) => ipcRenderer.invoke('print:windows-raw', job),
  printUsbDirect: (job) => ipcRenderer.invoke('print:usb-direct', job)
});
