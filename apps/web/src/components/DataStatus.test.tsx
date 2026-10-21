import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DataStatus } from "./DataStatus";
it("explicitly distinguishes no connection from measured zero", () => {
  const html=renderToStaticMarkup(<DataStatus/>);
  for (const value of ["NOT RUNNING","NOT CONNECTED","NOT MEASURED","MOCK / SIMULATED"]) expect(html).toContain(value);
  expect(html).not.toMatch(/<dd>0<\/dd>/); expect(html).toContain("not pipeline telemetry");
});
it("shows all requested monitoring categories without claiming a CLI run is live", () => {
  const html=renderToStaticMarkup(<DataStatus/>);
  for (const name of ["L1 / L2 / TRADES","Received / accepted / applied / persisted","Queue depth",
    "IPC unconfirmed","Last committed position","render lag","Reconnects / sequence gaps"])
    expect(html).toContain(name);
  expect(html).toContain("not connected to this browser");
});
