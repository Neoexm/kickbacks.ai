import type { LogTail } from "../activity/logTail";
import type { MetricsClient } from "../metrics/client";
import type { PatchAd } from "../portfolio/client";
import type { SbState } from "../statusbar";
import { dlog } from "../log";

const AD_DISPLAY_HOLD_MS = 6_000;
const POLL_INTERVAL_MS = 1_000;
const VIEW_TICK_INTERVAL_MS = 5_000;

export interface StatusBarAdDeps {
  logTail: LogTail;
  metrics: MetricsClient;
  statusBar: { set: (s: SbState) => void };
  adRef: { current: PatchAd | null };
  killedRef: { current: boolean };
  ccVersion: string;
  isSignedIn: () => boolean;
  showActive: () => Promise<void>;
  timers: NodeJS.Timeout[];
  // Shared arbiter flag: set true while the ad owns the status-bar item so the
  // periodic earnings refresh (showActive) won't paint over it. The poll also
  // re-asserts the ad each tick as a backstop against other setters
  // (kill/offline/incompatible) clobbering it mid-display.
  barState: { adShowing: boolean };
}

export function setupStatusBarAd(deps: StatusBarAdDeps): void {
  const {
    logTail, metrics, statusBar, adRef, killedRef,
    ccVersion, isSignedIn, showActive, timers, barState,
  } = deps;

  let showing = false;
  let showStartMs = 0;
  let corr = "";
  let revertTimer: NodeJS.Timeout | null = null;
  let viewTickTimer: NodeJS.Timeout | null = null;
  let shownAd: PatchAd | null = null;

  // The per-show viewTick/revert timers must be tracked in `timers` so
  // deactivate() (which clears actx.timers) stops them — otherwise a
  // disable/uninstall mid-display leaves a viewTick interval firing
  // metrics.send against a stale closure. We also splice on clear so the
  // shared array doesn't grow one stale handle per show.
  const track = (t: NodeJS.Timeout): NodeJS.Timeout => {
    timers.push(t);
    try { t.unref?.(); } catch { /* never disrupt */ }
    return t;
  };
  const untrack = (t: NodeJS.Timeout | null): void => {
    if (!t) return;
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };

  const stopViewTicks = (): void => {
    if (viewTickTimer) {
      clearInterval(viewTickTimer); untrack(viewTickTimer); viewTickTimer = null;
    }
  };

  const clearRevert = (): void => {
    if (revertTimer) {
      clearTimeout(revertTimer); untrack(revertTimer); revertTimer = null;
    }
  };

  const endShow = (): void => {
    if (!showing || !shownAd) return;
    const visibleMs = Date.now() - showStartMs;
    stopViewTicks();
    metrics.send("impression_viewable", {
      adId: shownAd.adId, campaignId: shownAd.campaignId,
      ccVersion, corr, surface: "statusbar",
      visibleMs, sessionToken: shownAd.sessionToken,
    });
    dlog("ext", "statusbar.ad.hide", { adId: shownAd.adId, visibleMs, corr });
    showing = false;
    shownAd = null;
    barState.adShowing = false;
  };

  const poll = (): void => {
    try {
      const activity = logTail.current();
      const thinking = !!activity && !activity.done;
      const ad = adRef.current;
      // Eligible to show the ad: Claude is thinking, we have an ad, signed in,
      // and not killed. Kill / sign-out / no-ad are NOT just "skip" — if we're
      // mid-display they must END the show (stop view_tick), otherwise the
      // timer keeps emitting view-family metrics for an ad that's gone.
      const eligible = thinking && !!ad && isSignedIn() && !killedRef.current;

      if (eligible) {
        clearRevert();
        if (!showing) {
          showing = true;
          showStartMs = Date.now();
          shownAd = ad;
          barState.adShowing = true;
          corr = "statusbar." + ad!.adId + "." +
            Math.random().toString(36).slice(2, 8);

          statusBar.set({ kind: "ad", adText: ad!.adText });

          dlog("ext", "statusbar.ad.show", { adId: ad!.adId, corr });
          metrics.send("impression_rendered", {
            adId: ad!.adId, campaignId: ad!.campaignId,
            ccVersion, corr, surface: "statusbar",
          });

          viewTickTimer = track(setInterval(() => {
            if (!shownAd) return;
            metrics.send("view_tick", {
              adId: shownAd.adId, campaignId: shownAd.campaignId,
              ccVersion, corr, surface: "statusbar",
              visibleMs: Date.now() - showStartMs,
              sessionToken: shownAd.sessionToken,
            });
          }, VIEW_TICK_INTERVAL_MS));
        } else {
          // Re-assert each tick: self-heals any clobber by another setter
          // (the 30s earnings refresh, offline/incompatible) so whenever a
          // view_tick fires, a visible ad was repainted within the last ~1s.
          statusBar.set({ kind: "ad", adText: shownAd!.adText });
        }
      } else if (showing) {
        // No longer eligible while mid-display. Always end the show so
        // view_tick stops and impression_viewable fires with the real
        // visible duration.
        endShow();
        // Schedule the 6s revert ONLY on a clean thinking→idle transition
        // while still able to show earnings. When kill / sign-out interrupted
        // the show, that setter already owns the bar — don't paint over it.
        if (!thinking && isSignedIn() && !killedRef.current && !revertTimer) {
          revertTimer = track(setTimeout(() => {
            untrack(revertTimer);
            revertTimer = null;
            void showActive();
          }, AD_DISPLAY_HOLD_MS));
        }
      }
    } catch { /* prime directive: never break activation */ }
  };

  timers.push(setInterval(poll, POLL_INTERVAL_MS));
}
