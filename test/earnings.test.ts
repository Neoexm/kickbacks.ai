import { describe, it, expect } from "vitest";
import { EarningsClient } from "../src/earnings/client";

const okFetch = (async () => ({
  ok: true,
  json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }),
})) as unknown as typeof fetch;
const errFetch = (async () => ({ ok: false })) as unknown as typeof fetch;
const badJson = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;

describe("EarningsClient", () => {
  it("returns today + lifetime when signed in", async () => {
    const c = new EarningsClient("http://x", () => "tok", okFetch);
    expect(await c.fetch()).toEqual({ lifetimeUsd: "1.20", todayUsd: "0.04" });
  });
  it("null when signed out (no token)", async () => {
    const c = new EarningsClient("http://x", () => null, okFetch);
    expect(await c.fetch()).toBeNull();
  });
  it("null on non-200", async () => {
    const c = new EarningsClient("http://x", () => "tok", errFetch);
    expect(await c.fetch()).toBeNull();
  });
  it("null when JSON missing fields", async () => {
    const c = new EarningsClient("http://x", () => "tok", badJson);
    expect(await c.fetch()).toBeNull();
  });
});
