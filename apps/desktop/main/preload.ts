import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload: inline fixed channel only, never expose ipcRenderer or events.
contextBridge.exposeInMainWorld("orderflowDesktop", Object.freeze({
  appName: "Orderflow Lab", mode: "MOCK / SIMULATED", apiVersion: 2,
  observations: Object.freeze({
    select: () => ipcRenderer.invoke("orderflow:observations:v1", { op: "select", generation: 0 }),
    read: (generation: number) => ipcRenderer.invoke("orderflow:observations:v1", { op: "read", generation }),
    stop: (generation: number) => ipcRenderer.invoke("orderflow:observations:v1", { op: "stop", generation }),
    release: (generation: number) => ipcRenderer.invoke("orderflow:observations:v1", { op: "release", generation }),
  }),
}));
