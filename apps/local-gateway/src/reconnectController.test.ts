import { expect, it } from "vitest";
import { ReconnectController } from "./reconnectController";
it("uses exact deterministic 1/2/4/8/16/30/30-second backoff", () => {
  let now=0, attempts=0, invalidations=0;
  const c=new ReconnectController(()=>now,()=>invalidations++,()=>attempts++);
  c.disconnect(); c.disconnect(); expect(invalidations).toBe(1);
  for (const delay of [1000,2000,4000,8000,16000,30000,30000]) {
    const prior=now; expect(c.nextAttemptMs).toBe(prior+delay);
    now+=delay-1; expect(c.tick()).toBe(false); now++; expect(c.tick()).toBe(true);
  }
  expect(attempts).toBe(7); expect(c.reconnectCount).toBe(7);
});
it("connection success alone cannot restore VALID; verified snapshot is mandatory", () => {
  const c=new ReconnectController(()=>0,()=>{},()=>{}); c.disconnect(); c.connected();
  expect(c.status).toBe("RESYNCING"); expect(c.tick()).toBe(false);
  expect(c.synchronized(false)).toBe(false); expect(c.status).toBe("RESYNCING");
  expect(c.synchronized(true)).toBe(true); expect(c.status).toBe("CONNECTED");
});
