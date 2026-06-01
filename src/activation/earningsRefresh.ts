import * as vscode from "vscode";
import type { AuthClient } from "../auth/client";
import type { EarningsClient } from "../earnings/client";
import type { SessionState } from "../sessionState";
import type { SbState } from "../statusbar";

export interface EarningsRefreshResult {
  showActive: () => Promise<void>;
  scheduleEarningsRefresh: (delayMs?: number) => void;
}

export function setupEarningsRefresh(
  auth: AuthClient,
  earningsClient: EarningsClient,
  session: SessionState,
  statusBar: { set: (s: SbState) => void },
  ccVersion: string,
  ctx: vscode.ExtensionContext,
  // Arbiter: true while the status-bar ad owns the item (set by statusBarAd).
  // When an ad is showing, showActive keeps the earnings data fresh but does
  // NOT paint over the ad — statusBarAd repaints the earnings label itself
  // when the ad reverts. Defaults to "never showing" for callers that don't
  // wire the arbiter (tests, other surfaces).
  isAdShowing: () => boolean = () => false,
): EarningsRefreshResult {
  let lastUsd: string | undefined;
  let lastToday: string | undefined;

  let pendingRefreshTimer: NodeJS.Timeout | null = null;
  const scheduleEarningsRefresh = (delayMs = 2500): void => {
    if (pendingRefreshTimer) clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = setTimeout(() => {
      pendingRefreshTimer = null;
      void showActive();
    }, delayMs);
    try { pendingRefreshTimer.unref?.(); } catch { /* never disrupt */ }
  };

  const showActive = async (): Promise<void> => {
    if (!auth.accessToken()) {
      statusBar.set({ kind: "signed-out" });
      session.set({ signedIn: false });
      return;
    }
    const e = await earningsClient.fetch();
    if (e) {
      lastUsd = e.lifetimeUsd; lastToday = e.todayUsd;
      session.set({ signedIn: true, authHealthy: "ok" });
    } else if (auth.accessToken()) {
      session.set({ signedIn: true, authHealthy: "401" });
    }
    // Don't clobber a live status-bar ad — it owns the item until it reverts,
    // at which point statusBarAd calls showActive() again (adShowing=false)
    // to paint these freshly-fetched figures.
    if (isAdShowing()) return;
    statusBar.set({ kind: "active", version: ccVersion,
                    usd: lastUsd, usdToday: lastToday });
  };

  // Initial status bar state + sign-in nudge.
  if (!auth.accessToken()) {
    statusBar.set({ kind: "signed-out" });
    const NUDGE_KEY = "kickbacks.signinNudge.shownAt";
    const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const lastShownAt = Number(ctx.globalState.get<number>(NUDGE_KEY) || 0);
    if (Date.now() - lastShownAt > NUDGE_COOLDOWN_MS) {
      void ctx.globalState.update(NUDGE_KEY, Date.now());
      void (async () => {
        try {
          const choice = await vscode.window.showInformationMessage?.(
            "Kickbacks: sign in to start earning on Claude Code spinner ads.",
            "Sign in", "Later");
          if (choice === "Sign in") {
            await vscode.commands.executeCommand("kickbacks.signIn");
          }
        } catch { /* toast is best-effort */ }
      })();
    }
  } else void showActive();

  return { showActive, scheduleEarningsRefresh };
}
