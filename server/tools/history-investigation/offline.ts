// Safety preload for these isolated tools; never import into the product.
import net from "node:net";
import http from "node:http";
import https from "node:https";
const forbidden = () => { throw Error("offline investigation: network is forbidden"); };
net.Socket.prototype.connect = forbidden as any;
http.request = forbidden as any;
https.request = forbidden as any;
globalThis.fetch = forbidden as any;
globalThis.WebSocket = class { constructor() { forbidden(); } } as any;
