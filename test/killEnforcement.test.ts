// Kill-switch enforcement: when the backend or the test override says
// killed=true, activate() must restore the CC + Codex targets and skip the
// loopback / patched-webview branch entirely. The test hooks (which talk
// directly to MetricsClient) intentionally remain callable so an operator
// can still drive an isolated event for diagnostics, but production-path
// telemetry is silent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, secrets, _opened, _shown, _openedDocs, commands }
  from "./mocks/vscode";

const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

function stubFetch(opts: { killedFromBackend?: boolean } = {}) {
  const calls: { url: string; method: string;
                 body?: unknown; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: unknown, init?: { method?: string;
      body?: string; headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? (() => {
      try { return JSON.parse(init.body!); } catch { return init.body; } })() : undefined;
    calls.push({ url, method, body, headers: init?.headers || {} });
    if (url.includes("/v1/killswitch")) {
      return { ok: true, status: 200, json: async () =>
        ({ killed: !!opts.killedFromBackend }) } as Response;
    }
    if (url.includes("/v1/portfolio")) {
      return { ok: true, status: 200, json: async () => ({
        ttl_seconds: 30, view_threshold_seconds: 15,
        ads: [{ ad_id: "ad-kill", campaign_id: "camp-kill",
          title_text: "x", icon_ref: "i", click_url: "https://x" }],
      }) } as Response;
    }
    return { ok: true, status: 204, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return { f, calls };
}

beforeEach(() => {
  secrets.clear();
  commands._handlers.clear();
  commands._executed.length = 0;
  _opened.length = 0;
  _shown.length = 0;
  _openedDocs.length = 0;
  __wireForTest({});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("kill-switch enforcement (production-path silence + hook callability)",
  () => {

  it("killed=true at activation: adapter.restore() runs, status bar = killed,"
    + " no loopback-driven /v1/metrics POSTs", async () => {
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar, killed: true });
    const fetched = stubFetch();
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-KILL");
    try {
      await activate(ctx as never);
      // Allow checkKill's async branch to settle.
      await new Promise((r) => setTimeout(r, 30));
      expect(adapter.restore).toHaveBeenCalled();
      expect(statusBar.set).toHaveBeenCalledWith(
        expect.objectContaining({ kind: expect.stringMatching(/^(killed|offline)$/) }));
      // No metric POSTs: the loopback branch never wires because killed=true.
      const metricsPosts = fetched.calls.filter(
        (c) => c.url.endsWith("/v1/metrics"));
      expect(metricsPosts).toHaveLength(0);
    } finally { await deactivate(); }
  });

  it("test hook fireImpressionRendered is STILL callable post-kill — the"
    + " operator-facing diagnostic surface bypasses the kill-switch (and"
    + " state.killed=true is reflected in the snapshot so a suite can guard"
    + " against unintended live writes)", async () => {
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar, killed: true });
    const fetched = stubFetch();
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-KILL2");
    try {
      await activate(ctx as never);
      await new Promise((r) => setTimeout(r, 30));
      // Hooks are registered iff testHooksEnabled() (the global setup mock
      // returns true). getState must reflect killed=true.
      const snap = await commands.executeCommand(
        "kickbacks.test.getState") as
        { killed: boolean; ad: { adId: string } | null };
      expect(snap.killed).toBe(true);
      // No ad was wired to the production loopback branch (it short-
      // circuited on killed=true). But fireImpressionRendered with an
      // explicit ad override should still send.
      const r = await commands.executeCommand(
        "kickbacks.test.fireImpressionRendered",
        { adId: "ad-kill", campaignId: "camp-kill" }) as { ok: boolean };
      expect(r.ok).toBe(true);
      const metricsPosts = fetched.calls.filter(
        (c) => c.url.endsWith("/v1/metrics"));
      expect(metricsPosts).toHaveLength(1);
      expect(metricsPosts[0].body).toMatchObject({
        event_type: "impression_rendered", ad_id: "ad-kill",
      });
    } finally { await deactivate(); }
  });

  it("backend-driven kill (test override OFF, backend killed=true) calls"
    + " /v1/killswitch, restores the adapter, and sets the status bar to"
    + " killed/offline. NOTE: the production code intentionally still runs"
    + " the first synchronous CLI-statusline sync in the same tick, so the"
    + " runtime guard for telemetry is adapter.restore() (no webview =>"
    + " no impressions) plus the 30s reassert timer flipping `killed`.",
    async () => {
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar });  // no test-override of killed
    const fetched = stubFetch({ killedFromBackend: true });
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-KILL3");
    try {
      await activate(ctx as never);
      await new Promise((r) => setTimeout(r, 30));
      expect(fetched.calls.some(
        (c) => c.url.includes("/v1/killswitch"))).toBe(true);
      expect(adapter.restore).toHaveBeenCalled();
      expect(statusBar.set).toHaveBeenCalledWith(
        expect.objectContaining({ kind: expect.stringMatching(/^(killed|offline)$/) }));
    } finally { await deactivate(); }
  });
});
