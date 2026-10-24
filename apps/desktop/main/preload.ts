import { contextBridge } from "electron";

// Sandboxed preloads cannot require local modules. Static, read-only metadata only;
// no ipcRenderer, filesystem, process, shell, command or arbitrary channel bridge.
contextBridge.exposeInMainWorld("orderflowDesktop", Object.freeze({
  appName: "Orderflow Lab", mode: "MOCK / SIMULATED", apiVersion: 1,
}));
