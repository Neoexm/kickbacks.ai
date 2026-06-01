import type * as vscode from "vscode";
import type { TargetAdapter, PatchParams } from "../adapters/types";
import type { AuthClient } from "../auth/client";
import type { DebugController } from "../debug";
import type { SessionState } from "../sessionState";
import type { PatchAd, PortfolioResponse } from "../portfolio/client";
import type { PortfolioClient } from "../portfolio/client";
import { newMetricEventUuid, type MetricsClient } from "../metrics/client";
import type { LogTail } from "../activity/logTail";
import type { TestHooks } from "../testHooks";
import type { ActivationContext } from "./context";
import type { SbState } from "../statusbar";
import { Loopback } from "../loopback";
import { bootLoopback } from "../util/loopbackBoot";
import { dlog, debugEnabled } from "../log";
import { errMsg } from "../util/errMsg";
import { resolveBannerOn } from "../banner";
import { webviewMode, bannerOverride } from "../modes";
import { ImpressionDedupe } from "../metrics/dedupe";
import { shouldReassert } from "../reassert";
import type { DesyncState } from "./desyncDetector";
import { setupAdRotation, type AdRotationDeps } from "./adRotation";

/** Anti-misclick floor: a click within the first CLICK_THRESHOLD_MS of
 *  cumulative ad visibility is logged but NOT forwarded to the metrics
 *  ledger. 15s per product call. */
const CLICK_THRESHOLD_MS = 15_000;

export interface WebviewInjectionDeps {
  ctx: vscode.ExtensionContext;
  actx: ActivationContext;
  adapter: TargetAdapter;
  auth: AuthClient;
  debugCtl: DebugController;
  session: SessionState;
  portfolio: PortfolioClient;
  metrics: MetricsClient;
  logTail: LogTail;
  testHooks: TestHooks;
  statusBar: { set: (s: SbState) => void };
  ccVersion: string;
  killed: boolean;
  /** Mutated by the caller when the kill-switch state changes. */
  killedRef: { current: boolean };
  /** Mutable ref for the outer `ad` variable. */
  adRef: { current: PatchAd | null };
  portfolioResp: PortfolioResponse | null;
  viewThresholdMs: number;
  statusBarShowActive: () => Promise<void>;
  scheduleEarningsRefresh: () => void;
  desyncState: DesyncState;
}

export interface WebviewInjectionResult {
  lbInfo: { port: number; base: string } | null;
  reapplyCodex: (() => void) | null;
  /** Production-path "hard" reassert: restore + re-applyPatch so the file's
   *  identity changes and VS Code re-evaluates a stale-cached webview module.
   *  Health-gated, guarded, never throws. Null when injection didn't set up
   *  (no ad / killed / loopback unavailable). Used by the desync watchdog. */
  cycleReassert: (() => void) | null;
}

/** Boot the loopback, patch the webview, set up reassert + ad rotation.
 *  Returns the loopback info and a Codex reapply function. */
export async function setupWebviewInjection(
  deps: WebviewInjectionDeps,
): Promise<WebviewInjectionResult> {
  const {
    ctx, actx, adapter, auth, debugCtl, session, portfolio,
    metrics, logTail, testHooks, statusBar, ccVersion, killedRef, adRef,
    portfolioResp, viewThresholdMs, statusBarShowActive,
    scheduleEarningsRefresh, desyncState,
  } = deps;
  const ad = adRef.current;
  if (!ad || deps.killed || webviewMode() !== "on") {
    return { lbInfo: null, reapplyCodex: null, cycleReassert: null };
  }

  // Stable snapshot of the activation-time ad.
  let activeAd = ad;
  let corr = activeAd.adId + "." + Math.random().toString(36).slice(2, 8);
  const impDedupe = new ImpressionDedupe();
  const codexAdapter = actx.codexAdapter;
  actx.loopback = new Loopback({
    onEvent: (k, payload) => {
      const eventUuid = payload.eventUuid || newMetricEventUuid();
      if (k !== "view_tick" && k !== "error_impression"
          && !impDedupe.shouldSend(k, activeAd.adId, payload.surface)) {
        dlog("ext", "metric.deduped",
          { event: k, surface: payload.surface, eventUuid }, { corr });
        return;
      }
      dlog("ext", "metric.send", { event: k, adId: activeAd.adId,
        surface: payload.surface, visibleMs: payload.visibleMs, eventUuid },
        { corr });
      metrics.send(k, {
        adId: activeAd.adId,
        campaignId: activeAd.campaignId,
        ccVersion,
        corr,
        sessionToken: activeAd.sessionToken,
        ...payload,
        eventUuid,
      });
      if (k === "view_threshold_met" || k === "impression_viewable"
          || k === "error_impression") {
        scheduleEarningsRefresh();
      }
    },
    onClick: (_ct, surface, visibleMs, eventUuidFromLoopback) => {
      const eventUuid = eventUuidFromLoopback || newMetricEventUuid();
      if (typeof visibleMs === "number" && visibleMs < CLICK_THRESHOLD_MS) {
        dlog("ext", "metric.click.early", { adId: activeAd.adId,
          surface, visibleMs, thresholdMs: CLICK_THRESHOLD_MS, eventUuid },
          { corr });
        return;
      }
      dlog("ext", "metric.send", { event: "click", adId: activeAd.adId,
        surface, visibleMs, eventUuid }, { corr });
      metrics.send("click", { adId: activeAd.adId, campaignId: activeAd.campaignId,
        ccVersion, corr, sessionToken: activeAd.sessionToken,
        eventUuid, ...(surface ? { surface } : {}) });
      scheduleEarningsRefresh();
    },
    getActivity: () => logTail.current() ?? {},
    getCurrentAd: () => activeAd ? {
      adText: activeAd.adText, clickUrl: activeAd.clickUrl,
      iconUrl: activeAd.iconUrl, adId: activeAd.adId,
      campaignId: activeAd.campaignId,
    } : null,
    onTestRoute: (n, p) => testHooks.handleTestRoute(n, p),
    onWebviewLog: (raw) => {
      try {
        if (raw.includes('"block.start"') || raw.includes("block.start")) {
          desyncState.lastBlockStartAt = Date.now();
        }
      } catch { /* best-effort */ }
    },
  });

  const { port, token, base: lbBase } = await bootLoopback(actx.loopback, ctx);
  const lbInfo = { port, base: lbBase };
  dlog("ext", "loopback", { port, base: lbBase });

  let patchParams: PatchParams = {
    tier: 3, adText: activeAd.adText, iconRef: activeAd.iconRef,
    iconUrl: activeAd.iconUrl, clickToken: "ck", clickUrl: activeAd.clickUrl,
    corr, loopbackPort: port,
    loopbackToken: token, loopbackBase: lbBase, debug: debugEnabled(),
    bannerOn: resolveBannerOn(activeAd.bannerEnabled === true, bannerOverride()),
    viewThresholdMs,
  };

  if (port < 0) {
    // EADDRINUSE / port-exhaustion: skip the apply.
    statusBar.set({ kind: "incompatible", version: ccVersion });
    dlog("ext", "loopback.unavailable", { port });
    return { lbInfo, reapplyCodex: null, cycleReassert: null };
  }

  const res = adapter.applyPatch(patchParams);
  dlog("ext", "applyPatch", { ok: res.ok, reason: res.reason });
  if (res.ok) {
    desyncState.lastApplyAt = Date.now();
    void statusBarShowActive();
  }
  else statusBar.set({ kind: "incompatible", version: ccVersion });

  // S9: patch Codex with the SAME ad/loopback params.
  const applyCodex = (): void => {
    if (!codexAdapter) return;
    if (port < 0) { dlog("ext", "codex.skip", { reason: "no-loopback" }); return; }
    try {
      const cpf = codexAdapter.preflight();
      if (!cpf.compatible) {
        dlog("ext", "codex.skip", { reason: cpf.reason });
        return;
      }
      const cr = codexAdapter.applyPatch(patchParams);
      dlog("ext", "codex.applyPatch", { ok: cr.ok, reason: cr.reason });
    } catch (e) {
      dlog("ext", "codex.error", { msg: errMsg(e) });
    }
  };
  const reapplyCodex = applyCodex;
  actx.timers.push(setTimeout(applyCodex, 10_000));

  // Reassert the injection on a timer.
  const reassertWebview = (): void => {
    try {
      if (!shouldReassert({ signedIn: !!auth.accessToken(),
          haveAd: !!adRef.current, killed: killedRef.current })) return;
      if (adapter.isPatched?.() !== true) {
        const r = adapter.applyPatch(patchParams);
        if (!r.ok) dlog("ext", "reassert.skip", { reason: r.reason });
      }
      if (codexAdapter && codexAdapter.isPatched?.() !== true) {
        applyCodex();
      }
    } catch { /* prime directive: never break activation */ }
  };
  actx.timers.push(setInterval(reassertWebview, 60_000));

  // "Hard" reassert for the webview-cache desync (file is patched but the
  // webview cached the pre-patch module, so isPatched()-gated reasserts can't
  // see it). restore() + applyPatch() changes the file's identity, nudging VS
  // Code to re-evaluate the module. Health-gated like reassertWebview; only
  // ever invoked by the desync watchdog after sustained, CC-active silence.
  const cycleReassert = (): void => {
    try {
      if (!shouldReassert({ signedIn: !!auth.accessToken(),
          haveAd: !!adRef.current, killed: killedRef.current })) return;
      adapter.restore();
      const r = adapter.applyPatch(patchParams);
      if (r.ok) desyncState.lastApplyAt = Date.now();
      applyCodex();
      dlog("ext", "reassert.cycle", { ok: r.ok, reason: r.reason });
    } catch { /* prime directive: never break activation */ }
  };

  // Ad rotation subsystem.
  setupAdRotation({
    adapter, portfolio, auth, debugCtl, session, ccVersion, port,
    patchParams,
    activeAdRef: { get current() { return activeAd; }, set current(v) { activeAd = v; } },
    corrRef: { get current() { return corr; }, set current(v) { corr = v; } },
    adRef,
    impDedupe,
    reapplyCodex,
    timers: actx.timers,
  } as AdRotationDeps, portfolioResp);

  return { lbInfo, reapplyCodex, cycleReassert };
}
