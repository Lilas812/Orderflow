import { expect, it } from "vitest";
import { IpcCredits, ipcBatch } from "./mockTransport";
it("bounds all IPC ownership until both receipt and durable ACK", () => {
  const c=new IpcCredits(4,100);
  expect(c.reserve(1,3,60)).toBe(true); expect(c.paused).toBe(true);
  expect(c.reserve(2,1,20)).toBe(false); c.received(1);
  expect(c.snapshot()).toMatchObject({outstandingEvents:3,unconfirmedSendEvents:0});
  expect(c.reserve(2,1,20)).toBe(false); c.committed(1);
  expect(c.paused).toBe(false); expect(c.count).toBe(0);
});
it("enforces bytes independently of count", () => {
  const c=new IpcCredits(100,10);
  expect(c.reserve(1,1,11)).toBe(false); expect(c.bytes).toBe(0);
  expect(c.reserve(1,1,8)).toBe(true); expect(c.paused).toBe(true);
});
it("never grants credits for unacknowledged or duplicated messages", () => {
  const c=new IpcCredits(); c.reserve(1,1,100);
  expect(()=>c.committed(1)).toThrow(); c.received(1); expect(()=>c.received(1)).toThrow();
  c.committed(1); expect(()=>c.committed(1)).toThrow();
});
it("keeps sender receipt count/bytes distinct from pending commits", () => {
  const c=new IpcCredits(); c.reserve(1,10,100); c.reserve(2,20,200); c.received(1);
  expect(c.snapshot()).toMatchObject({outstandingEvents:30,outstandingBytes:300,unconfirmedSendEvents:20,unconfirmedSendBytes:200});
});
it("counts the complete serialized IPC message, including the envelope",()=>{
  const m=ipcBatch(1,[{data:"MOCK"}]);
  expect(m.bytes).toBe(Buffer.byteLength(JSON.stringify(m),"utf8"));
  expect(m.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(m.events),"utf8"));
});
