import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupStatusBarAd, type StatusBarAdDeps } from "../src/activation/statusBarAd";
import type { Activity } from "../src/activity/logTail";

function makeDeps(overrides: Partial<StatusBarAdDeps> = {}): StatusBarAdDeps & {
  statusBar: { set: ReturnType<typeof vi.fn>; lastState: unknown };
  metrics: { send: ReturnType<typeof vi.fn> };
  showActive: ReturnType<typeof vi.fn>;
  logTail: { current: ReturnType<typeof vi.fn> };
} {
  const statusBar = { set: vi.fn(), lastState: null as unknown };
  statusBar.set.mockImplementation((s: unknown) => { statusBar.lastState = s; });
  const metrics = { send: vi.fn() };
  const showActive = vi.fn().mockResolvedValue(undefined);
  const logTail = { current: vi.fn().mockReturnValue(null) };
  return {
    logTail: logTail as any,
    metrics: metrics as any,
    statusBar,
    adRef: { current: { adId: "ad1", campaignId: "c1", seat: "s1",
      adText: "Try Acme Widgets", iconRef: "", iconUrl: "",
      clickUrl: "https://acme.com", bannerEnabled: false,
      sessionToken: "tok1" } },
    killedRef: { current: false },
    ccVersion: "2.1.143",
    isSignedIn: () => true,
    showActive,
    timers: [],
    barState: { adShowing: false },
    ...overrides,
  } as any;
}

function thinking(): Activity {
  return { tool: "Edit", elapsedMs: 1000, ts: Date.now(), done: false };
}
function idle(): Activity {
  return { tool: "Edit", elapsedMs: 5000, ts: Date.now(), done: true };
}

describe("setupStatusBarAd", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does nothing when logTail returns null", () => {
    const d = makeDeps();
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("does nothing when done === true (idle)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(idle());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("shows ad text on first thinking detection", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
  });

  it("fires impression_rendered with surface statusbar", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({
        adId: "ad1", campaignId: "c1", surface: "statusbar",
      }));
  });

  it("does not re-fire impression_rendered while still thinking", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(5000);
    const renderedCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_rendered");
    expect(renderedCalls).toHaveLength(1);
  });

  it("fires view_tick every 5 seconds while showing", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(11_000);
    const tickCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(tickCalls.length).toBeGreaterThanOrEqual(2);
    expect(tickCalls[0][1]).toMatchObject({ surface: "statusbar" });
  });

  it("fires impression_viewable when thinking ends", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    const viewableCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewableCalls).toHaveLength(1);
    expect(viewableCalls[0][1]).toMatchObject({ surface: "statusbar" });
    expect(viewableCalls[0][1].visibleMs).toBeGreaterThan(0);
  });

  it("calls showActive after 6-second hold when thinking ends", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(2000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    expect(d.showActive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000);
    expect(d.showActive).toHaveBeenCalledTimes(1);
  });

  it("does not show ad when signed out", () => {
    const d = makeDeps({ isSignedIn: () => false });
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("does not show ad when killed", () => {
    const d = makeDeps();
    d.killedRef.current = true;
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("does not show ad when no ad available", () => {
    const d = makeDeps();
    d.adRef.current = null;
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("re-shows ad on next thinking burst after idle", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(2000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(8000);
    d.metrics.send.mockClear();
    d.logTail.current.mockReturnValue(thinking());
    vi.advanceTimersByTime(1000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad" }));
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({ surface: "statusbar" }));
  });

  // H4: arbiter flag is set while the ad owns the bar, cleared when it ends.
  it("sets barState.adShowing while the ad holds the bar and clears it on hide", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.barState.adShowing).toBe(true);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    expect(d.barState.adShowing).toBe(false);
  });

  // H4: a clobber by another setter (e.g. the 30s earnings refresh) self-heals
  // — the next poll re-asserts kind:"ad" so a firing view_tick always matches a
  // visible ad.
  it("re-asserts the ad each tick while thinking (self-heals clobbers)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);            // first show
    d.statusBar.set.mockClear();
    vi.advanceTimersByTime(1000);            // next tick re-asserts
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
  });

  // M3 / H4: kill flipping ON mid-display must END the show — view_tick must
  // STOP and impression_viewable must fire, not keep emitting for a killed ad.
  it("ends the show (stops view_tick) when killed mid-display", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(6000);            // showing + at least one view_tick
    d.killedRef.current = true;              // kill switch trips mid-burst
    vi.advanceTimersByTime(1000);            // next poll sees killed
    expect(d.metrics.send).toHaveBeenCalledWith("impression_viewable",
      expect.objectContaining({ surface: "statusbar" }));
    expect(d.barState.adShowing).toBe(false);
    const ticksBefore = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    vi.advanceTimersByTime(15_000);          // ad still "thinking" but killed
    const ticksAfter = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(ticksAfter).toBe(ticksBefore);    // no ghost view_tick after kill
  });

  // M3: when killed mid-display, the kill setter owns the bar — statusBarAd
  // must NOT call showActive() (which would paint over the "killed" state).
  it("does not call showActive when killed mid-display", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    d.killedRef.current = true;
    vi.advanceTimersByTime(2000);
    expect(d.showActive).not.toHaveBeenCalled();
  });
});
