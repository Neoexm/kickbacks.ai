import { describe, it, expect, vi } from "vitest";
import { PortfolioClient } from "../src/portfolio/client";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("PortfolioClient", () => {
  it("maps S2's real flat shape into a PatchAd; caches with ttl", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a1", campaign_id: "c1", seat: "c1", weight: 1,
              title_text: "Acme deploys faster than your CI now", icon_ref: "icon.a",
              click_url: "https://acme.test/x" }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    expect(ad).toEqual({ adId: "a1", campaignId: "c1", seat: "c1",
      adText: "Acme deploys faster than your CI now", iconRef: "icon.a",
      iconUrl: "", clickUrl: "https://acme.test/x", bannerEnabled: false,
      sessionToken: "" });
  });

  it("banner_enabled:true in payload => bannerEnabled true", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a2", campaign_id: "c2", seat: "c2", weight: 1,
              title_text: "Banner ad text", icon_ref: "icon.b",
              click_url: "https://banner.test/x", banner_enabled: true }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    expect(ad?.bannerEnabled).toBe(true);
  });

  it("banner_enabled absent in payload => bannerEnabled false", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a3", campaign_id: "c3", seat: "c3", weight: 1,
              title_text: "No banner ad text", icon_ref: "icon.c",
              click_url: "https://nobanner.test/x" }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    expect(ad?.bannerEnabled).toBe(false);
  });

  it("empty ads -> null (valid: no patch)", async () => {
    const c = new PortfolioClient("http://b", () => "tok",
      (async () => ok({ ttl_seconds: 60, ads: [] })) as never);
    expect(await c.fetchAd("2.1.143")).toBeNull();
  });

  it("on fetch error serves last good ad until ttl, then null", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) return ok({ ttl_seconds: 0, ads: [{ ad_id: "a1", campaign_id: "c1",
        seat: "c1", weight: 1, title_text: "x".repeat(35), icon_ref: "i",
        click_url: "https://t/x" }] });
      throw new Error("network down");
    });
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    expect((await c.fetchAd("2.1.143"))?.adId).toBe("a1");   // primes cache
    // ttl_seconds:0 -> cache already expired, error -> null
    expect(await c.fetchAd("2.1.143")).toBeNull();
  });
});
