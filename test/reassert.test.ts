import { describe, it, expect } from "vitest";
import { shouldReassert, desyncDecision } from "../src/reassert";

describe("shouldReassert", () => {
  const healthy = { signedIn: true, haveAd: true, killed: false };

  it("reasserts when signed in, have an ad, not killed", () => {
    expect(shouldReassert(healthy)).toBe(true);
  });
  it("does not reassert when signed out", () => {
    expect(shouldReassert({ ...healthy, signedIn: false })).toBe(false);
  });
  it("does not reassert when there is no ad", () => {
    expect(shouldReassert({ ...healthy, haveAd: false })).toBe(false);
  });
  it("does not reassert when kill-switched (never fights checkKill)", () => {
    expect(shouldReassert({ ...healthy, killed: true })).toBe(false);
  });
});

describe("desyncDecision (tiered self-heal policy)", () => {
  // Desynced + CC actively in use + past the grace window: applied ~9.9 min
  // ago, overlay never rendered since (lastBlockStartAt < lastApplyAt), CC
  // wrote its transcript 1s ago.
  const base = {
    now: 10_000_000,
    startedAt: 10_000_000 - 600_000,
    lastApplyAt: 10_000_000 - 590_000,
    lastBlockStartAt: 10_000_000 - 595_000,
    ccActivityAgeMs: 1_000,
    healthy: true,
    cyclePatchTried: false,
    reloadTried: false,
    toastShownAt: 0,
  };

  it("escalates to cycle first (cheapest heal)", () => {
    expect(desyncDecision(base).action).toBe("cycle");
  });
  it("then reload once a cycle was tried", () => {
    expect(desyncDecision({ ...base, cyclePatchTried: true }).action).toBe("reload");
  });
  it("then a window-reload toast once reload was tried", () => {
    expect(desyncDecision({ ...base, cyclePatchTried: true, reloadTried: true })
      .action).toBe("toast");
  });
  it("holds the toast on cooldown", () => {
    const r = desyncDecision({ ...base, cyclePatchTried: true, reloadTried: true,
      toastShownAt: base.now - 1_000 });
    expect(r.action).toBe("none");
    expect(r.reason).toBe("cooldown");
  });

  it("does NOTHING when CC is idle — the key non-aggression guard", () => {
    expect(desyncDecision({ ...base, ccActivityAgeMs: null }).reason).toBe("cc-idle");
    expect(desyncDecision({ ...base, ccActivityAgeMs: null }).action).toBe("none");
    expect(desyncDecision({ ...base, ccActivityAgeMs: 10 * 60_000 }).reason)
      .toBe("cc-idle");
  });
  it("does nothing when unhealthy (signed-out / no-ad / killed)", () => {
    expect(desyncDecision({ ...base, healthy: false }).action).toBe("none");
  });
  it("does nothing before the first apply", () => {
    expect(desyncDecision({ ...base, lastApplyAt: 0 }).reason).toBe("no-apply");
  });
  it("does nothing while in sync (overlay rendered since apply)", () => {
    const r = desyncDecision({ ...base, lastBlockStartAt: base.lastApplyAt + 1 });
    expect(r.action).toBe("none");
    expect(r.reason).toBe("in-sync");
  });
  it("waits out the grace window before escalating", () => {
    const r = desyncDecision({ ...base,
      startedAt: base.now - 60_000,
      lastApplyAt: base.now - 50_000,
      lastBlockStartAt: base.now - 60_000 });
    expect(r.action).toBe("none");
    expect(r.reason).toBe("within-grace");
  });
});
