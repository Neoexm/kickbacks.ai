import { describe, it, expect, vi } from "vitest";
import { MetricsClient } from "../src/metrics/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("MetricsClient", () => {
  it("POSTs a well-formed metrics_event with a fresh UUID nonce + auth", async () => {
    const calls: { url: string; body: any; hdr: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), hdr: init.headers });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    expect(calls[0].url).toBe("http://b/v1/metrics");
    const b = calls[0].body;
    expect(b).toMatchObject({ event_type: "click", ad_id: "a1", campaign_id: "c1",
      client_id: "cid", claude_code_version: "2.1.143", extension_version: "0.1.0" });
    expect(typeof b.ts).toBe("string");
    expect(b.nonce).toMatch(UUID_RE);
    expect(calls[0].body.nonce).not.toBe(calls[1].body.nonce); // fresh per event
    expect(calls[0].hdr.authorization).toBe("Bearer tok");
  });
  it("uses an explicit event UUID as the transmitted nonce", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    const eventUuid = "123e4567-e89b-42d3-a456-426614174000";
    await c.send("click", {
      adId: "a1",
      campaignId: "c1",
      ccVersion: "2.1.143",
      eventUuid,
    });

    expect(calls[0].body.nonce).toBe(eventUuid);
  });
  it("sends X-Vibe-Corr only when corr is provided", async () => {
    const calls: { hdr: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ hdr: init.headers });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v",
      corr: "a.r3nd" });
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v" }); // no corr
    expect(calls[0].hdr["X-Vibe-Corr"]).toBe("a.r3nd");
    expect(calls[0].hdr.authorization).toBe("Bearer tok"); // existing hdrs intact
    expect(calls[0].hdr["content-type"]).toBe("application/json");
    expect("X-Vibe-Corr" in calls[1].hdr).toBe(false); // omitted when absent
  });
  it("sends view threshold fields for billable view tracking", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("view_threshold_met", {
      adId: "a",
      campaignId: "c",
      ccVersion: "v",
      surface: "overlay",
      visibleMs: 15100,
      sessionNonce: "session123",
      viewable: true,
      viewPct: 100,
      viewMs: 15100,
    });

    expect(calls[0].body).toMatchObject({
      event_type: "view_threshold_met",
      surface: "overlay",
      visible_ms: 15100,
      session_nonce: "session123",
      viewable: true,
      view_pct: 100,
      view_ms: 15100,
    });
  });
  it("never throws on network failure", async () => {
    const c = new MetricsClient("http://b", () => null, () => "cid", "0.1.0",
      (async () => { throw new Error("down"); }) as never);
    await expect(c.send("impression_rendered",
      { adId: "a", campaignId: "c", ccVersion: "v" })).resolves.toBeUndefined();
  });
});
