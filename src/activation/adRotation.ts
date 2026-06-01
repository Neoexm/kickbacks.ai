import type { PatchAd, PortfolioResponse } from "../portfolio/client";
import type { PortfolioClient } from "../portfolio/client";
import type { TargetAdapter, PatchParams } from "../adapters/types";
import type { DebugController } from "../debug";
import type { AuthClient } from "../auth/client";
import type { SessionState } from "../sessionState";
import { dlog } from "../log";

export interface AdRotationDeps {
  adapter: TargetAdapter;
  portfolio: PortfolioClient;
  auth: AuthClient;
  debugCtl: DebugController;
  session: SessionState;
  ccVersion: string;
  port: number;
  patchParams: PatchParams;
  /** Mutable ref: the currently active ad. Updated in-place by rotation. */
  activeAdRef: { current: PatchAd };
  /** Mutable ref: the current correlation id. Updated on ad change. */
  corrRef: { current: string };
  /** Mutable ref: the outer ad variable (closure-scope in activate). */
  adRef: { current: PatchAd | null };
  impDedupe: { reset(): void };
  reapplyCodex: (() => void) | null;
  timers: NodeJS.Timeout[];
}

export interface AdRotationState {
  adQueue: PatchAd[];
  rotationIdx: number;
  rotationTimer: ReturnType<typeof setInterval> | null;
  lastAdSetSig: string;
}

/** Apply a new ad to the adapter + Codex, updating all shared refs. */
function applyAd(
  next: PatchAd,
  deps: AdRotationDeps,
  state: AdRotationState,
): void {
  const adChanged = next.adId !== deps.adRef.current?.adId;
  deps.adRef.current = next;
  deps.session.set({ hasAd: true });
  deps.debugCtl?.setPortfolioAd(next.adText, next.clickUrl || "");
  if (adChanged && deps.port > 0) {
    deps.activeAdRef.current = next;
    deps.corrRef.current = next.adId + "." + Math.random().toString(36).slice(2, 8);
    deps.impDedupe.reset();
    deps.patchParams = { ...deps.patchParams, adText: next.adText,
      iconRef: next.iconRef, iconUrl: next.iconUrl,
      clickUrl: next.clickUrl };
    deps.adapter.applyPatch(deps.patchParams);
    deps.reapplyCodex?.();
    dlog("ext", "portfolio.rotated", { adId: next.adId, corr: deps.corrRef.current });
  }
}

function rotateNext(deps: AdRotationDeps, state: AdRotationState): void {
  if (state.adQueue.length < 2) return;
  state.rotationIdx = (state.rotationIdx + 1) % state.adQueue.length;
  applyAd(state.adQueue[state.rotationIdx], deps, state);
}

async function refreshPortfolio(
  deps: AdRotationDeps,
  state: AdRotationState,
): Promise<void> {
  try {
    if (!deps.auth.accessToken()) return;
    const r = await deps.portfolio.fetchPortfolio(deps.ccVersion);
    if (!r || r.ads.length === 0) return;
    const newSig = r.ads.map(a => a.adId).sort().join(",");
    const adsChanged = newSig !== state.lastAdSetSig;
    if (adsChanged) {
      state.adQueue = r.ads;
      state.rotationIdx = 0;
      state.lastAdSetSig = newSig;
      applyAd(state.adQueue[0], deps, state);
      dlog("ext", "portfolio.refresh", { adId: state.adQueue[0].adId, queueLen: state.adQueue.length, changed: true });
      if (state.rotationTimer) clearInterval(state.rotationTimer);
      if (state.adQueue.length > 1) {
        state.rotationTimer = setInterval(() => rotateNext(deps, state), r.rotationIntervalMs);
        deps.timers.push(state.rotationTimer);
      }
    } else {
      dlog("ext", "portfolio.unchanged", { queueLen: r.ads.length, rotationIdx: state.rotationIdx });
    }
  } catch { /* prime directive */ }
}

/** Set up the ad-rotation subsystem. Returns cleanup state (timers are
 *  pushed into the shared `deps.timers` array). */
export function setupAdRotation(
  deps: AdRotationDeps,
  portfolioResp: PortfolioResponse | null,
): AdRotationState {
  const state: AdRotationState = {
    adQueue: portfolioResp?.ads ?? [],
    rotationIdx: 0,
    rotationTimer: null,
    lastAdSetSig: (portfolioResp?.ads ?? []).map(a => a.adId).sort().join(","),
  };
  const initialRotationMs = portfolioResp?.rotationIntervalMs ?? 120_000;
  if (state.adQueue.length > 1) {
    state.rotationTimer = setInterval(() => rotateNext(deps, state), initialRotationMs);
    deps.timers.push(state.rotationTimer);
    dlog("ext", "rotation.init", { intervalMs: initialRotationMs, queueLen: state.adQueue.length });
  }

  deps.timers.push(setInterval(() => void refreshPortfolio(deps, state), 60_000));
  return state;
}
