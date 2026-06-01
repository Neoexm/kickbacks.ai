import { describe, it, expect, vi } from "vitest";
import { KillSwitchClient } from "../src/killswitch/client";

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;

describe("KillSwitchClient", () => {
  it("checkOnce returns killed flag from the endpoint (offline=false)", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => ok({ killed: true, scope: "global", reason: "stop" })) as never);
    expect(await c.checkOnce("2.1.143", "c1")).toEqual(
      { killed: true, scope: "global", reason: "stop", offline: false });
  });
  it("fail-safe: on network error treat as KILLED + offline=true (wave-2A-F06)", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => { throw new Error("down"); }) as never);
    const r = await c.checkOnce("2.1.143", "c1");
    expect(r.killed).toBe(true);
    expect(r.offline).toBe(true);
  });
  it("fail-safe: on non-ok status treat as KILLED + offline=true", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => ({ ok: false, status: 502 }) as Response) as never);
    const r = await c.checkOnce("2.1.143", "c1");
    expect(r.killed).toBe(true);
    expect(r.offline).toBe(true);
  });
});
