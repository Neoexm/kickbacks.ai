import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { locateClaudeCode, locateClaudeCodeLog } from "./locate";
import { ClaudeCodeAdapter } from "./adapters/claude-code/adapter";
import { CodexAdapter } from "./adapters/codex/adapter";
import { locateCodexTarget } from "./adapters/registry";
import type { TargetAdapter, PatchParams } from "./adapters/types";
import { StatusBar } from "./statusbar";
import { LogTail } from "./activity/logTail";
import { PortfolioClient } from "./portfolio/client";
import { MetricsClient, newMetricEventUuid } from "./metrics/client";
import { AuthClient } from "./auth/client";
import { KillSwitchClient } from "./killswitch/client";
import { setupSelfUpdate } from "./activation/selfUpdate";
import { EarningsClient } from "./earnings/client";
import { ConsentClient } from "./consent/client";
import { maybePromptForConsent } from "./consent/prompt";
import { DebugController } from "./debug";
import { setupBootCanary } from "./activation/bootCanary";
import { setupDesyncDetector, type DesyncState } from "./activation/desyncDetector";
import { shouldReassert } from "./reassert";
import { setupStatusBarAd } from "./activation/statusBarAd";
import { registerCommands, restoreCodexSafe } from "./activation/commands";
import { setupEarningsRefresh } from "./activation/earningsRefresh";
import { setupWebviewInjection } from "./activation/webviewInjection";
import { setupCliSync } from "./activation/cliSync";
import { createActivationContext, type ActivationContext } from "./activation/context";
import { TestHooks } from "./testHooks";
import { buildLabel, buildVersion } from "./buildinfo";
import { dlog, debugEnabled, codexEnabled, codexCliEnabled,
         testHooksEnabled } from "./log";
import { webviewMode } from "./modes";
import { SessionState } from "./sessionState";
import { watchFile as nodeWatchFile, readFileSync, statSync } from "node:fs";
import { reloadSentinelPath, parseSentinel, decideReload } from "./reloadSignal";
import { readConfig, resolveBackendBase, resolveUpdateBase, configPath,
  ensureConfigFile, DEFAULT_POLL_MS } from "./config";
import { isLoopbackBase } from "./util/loopback";
import { errMsg } from "./util/errMsg";

const CFG = readConfig();

const BASE = (() => {
  const v = resolveBackendBase(CFG,
    process.env.KICKBACKS_BASE || process.env.VIBE_ADS_BASE);
  if (v.startsWith("http://")) {
    const looplike = isLoopbackBase(v);
    if (!looplike) {
      // eslint-disable-next-line no-console
      console.error(`Kickbacks: refusing non-loopback HTTP base "${v}". ` +
        `Set VIBE_ADS_BASE (or ~/.vibe-ads/config.json) to https://...`);
      return "https://invalid.example.invalid";
    }
  }
  return v;
})();

const UPDATE_BASE = resolveUpdateBase(CFG, process.env.KICKBACKS_UPDATE_BASE);

interface Wiring {
  adapter: TargetAdapter;
  codexAdapter?: TargetAdapter | null;
  statusBar: { set: (s: unknown) => void; dispose: () => void };
  watchFileFn: typeof import("node:fs").watchFile;
  killed?: boolean;
}
let override: Partial<Wiring> | null = null;
export function __wireForTest(w: Partial<Wiring>): void { override = w; }

const watchFileImpl = (): typeof import("node:fs").watchFile =>
  override?.watchFileFn ?? nodeWatchFile;

// ─── Activation Context ───────────────────────────────────────────────
let actx: ActivationContext = createActivationContext();

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    actx = createActivationContext();

    const target = locateClaudeCode();
    const adapter: TargetAdapter = override?.adapter ??
      new ClaudeCodeAdapter(target || "/__vibe_ads_no_target__");
    actx.ccAdapter = adapter;

    // S9: resolve the optional Codex target.
    actx.codexAdapter = override
      ? (override.codexAdapter ?? null)
      : (codexEnabled()
          ? (() => {
              try {
                const ct = locateCodexTarget();
                return ct ? new CodexAdapter(ct) : null;
              } catch { return null; }
            })()
          : null);
    const codexAdapter = actx.codexAdapter;
    const statusBar = override?.statusBar ?? new StatusBar();

    const session = new SessionState();

    // Manual admin/debug override.
    actx.debugCtl = new DebugController(adapter, ctx,
      (on) => {
        statusBar.set({ kind: "debug", on });
        session.set({ injectionOn: on });
      });
    const debugCtl = actx.debugCtl;
    debugCtl.setCodexAdapter(codexAdapter);

    const dm = () => debugCtl?.openMenu();
    const ec = async () => { try { await debugCtl?.editConfig(); } catch { /* ok */ } };
    ctx.subscriptions.push(
      vscode.commands.registerCommand("kickbacks.debugMenu", dm),
      vscode.commands.registerCommand("vibe-ads.debugMenu", dm),
      vscode.commands.registerCommand("kickbacks.editConfig", ec),
    );

    // Test hook injection commands (before preflight early-return).
    if (testHooksEnabled()) {
      ctx.subscriptions.push(
        vscode.commands.registerCommand("kickbacks.test.disableInjection",
          async () => {
            dlog("ext", "testhook.setInjection.fire", { on: false });
            await debugCtl?.setOn(false);
            dlog("ext", "testhook.setInjection.done",
              { on: false, hasDebugCtl: !!debugCtl });
          }),
        vscode.commands.registerCommand("kickbacks.test.enableInjection",
          async () => {
            dlog("ext", "testhook.setInjection.fire", { on: true });
            await debugCtl?.setOn(true);
            dlog("ext", "testhook.setInjection.done",
              { on: true, hasDebugCtl: !!debugCtl });
          }));
      void vscode.commands.executeCommand(
        "setContext", "kickbacks.test.enabled", true);
      dlog("ext", "testhook.injection.enabled", {});
    }

    // ─── Reload sentinel watcher ────────────────────────────────────
    try {
      const trig = reloadSentinelPath();
      const runningVersion = buildVersion();
      const armedAt = Date.now();
      const LAST_HANDLED_KEY = "vibe-ads.reload.lastHandledMtimeMs";
      const RESTART_ATTEMPT_CAP = 3;
      let restartAttempts = 0;
      const persistedHandledMtime = Number(ctx.globalState.get<number>(LAST_HANDLED_KEY) || 0);
      let highestHandledMtime = Math.max(armedAt, persistedHandledMtime);
      watchFileImpl()(trig, { interval: 1000 }, (curr) => {
        let raw: string;
        try { raw = readFileSync(trig, "utf8"); } catch { return; }
        const payload = parseSentinel(raw);
        if (!payload) return;
        if (curr.mtimeMs <= highestHandledMtime) {
          dlog("ext", "reload.skew_ignored", { mtime: curr.mtimeMs,
            highestHandled: highestHandledMtime });
          return;
        }
        const decision = decideReload({
          mtimeMs: curr.mtimeMs, armedAt,
          sentinelVersion: payload.version, runningVersion,
          debug: debugEnabled() });
        dlog("ext", "reload.decision", { decision, mtime: curr.mtimeMs,
          armedAt, sentinelVersion: payload.version, runningVersion,
          attempts: restartAttempts });
        if (decision !== "none") {
          if (restartAttempts >= RESTART_ATTEMPT_CAP) {
            dlog("ext", "reload.cap_hit", { cap: RESTART_ATTEMPT_CAP,
              mtime: curr.mtimeMs });
            return;
          }
          restartAttempts++;
          highestHandledMtime = curr.mtimeMs;
          void ctx.globalState.update(LAST_HANDLED_KEY, curr.mtimeMs);
          vscode.commands.executeCommand("workbench.action.restartExtensionHost");
        }
      });
    } catch { /* watcher is best-effort; never disturb activation */ }

    // ─── Config-file watcher ────────────────────────────────────────
    try {
      const cfgPath = configPath();
      let lastCfgMtime = 0;
      try { lastCfgMtime = statSync(cfgPath).mtimeMs; } catch { /* absent ok */ }
      watchFileImpl()(cfgPath, { interval: 2000 }, (curr) => {
        if (!curr.mtimeMs || curr.mtimeMs === lastCfgMtime) return;
        lastCfgMtime = curr.mtimeMs;
        dlog("ext", "config.changed", { mtime: curr.mtimeMs });
        vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      });
    } catch { /* never block activation */ }

    // ─── Local-source update ────────────────────────────────────────
    const localVsixPath = CFG.localVsixPath;
    let lastLocalVsixMtime = 0;
    if (localVsixPath) {
      try {
        lastLocalVsixMtime = statSync(localVsixPath).mtimeMs;
      } catch { /* missing initially is fine */ }
    }

    dlog("ext", "activate", { target: !!target, build: buildLabel(),
      debug: debugEnabled() });

    // Boot canary.
    await setupBootCanary(adapter, debugCtl, ctx);

    const pf = adapter.preflight();
    dlog("ext", "preflight", { compatible: pf.compatible, version: pf.version });
    if (!pf.compatible) {
      statusBar.set({ kind: "incompatible", version: pf.version ?? "unknown" });
      return;
    }

    // ─── Auth / clients ─────────────────────────────────────────────
    const auth = new AuthClient(BASE, ctx);
    await auth.loadCached();
    session.set({
      signedIn: !!auth.accessToken(),
      injectionOn: debugCtl.on(),
    });
    debugCtl.setAuth({
      signedIn: () => auth.signedIn(),
      storageInfo: () => auth.storageInfo(),
      signOut: () => auth.signOut(),
    });
    debugCtl.setSessionSnap(() => session.get());
    const portfolio = new PortfolioClient(BASE, () => auth.accessToken());
    const metrics = new MetricsClient(BASE, () => auth.accessToken(),
      () => auth.clientId(), buildVersion());
    const kill = new KillSwitchClient(BASE);
    const { updater } = setupSelfUpdate(
      ctx, UPDATE_BASE, buildVersion(), localVsixPath, lastLocalVsixMtime,
      watchFileImpl(), actx.timers, CFG.updatePollIntervalMs);
    const logTail = new LogTail(locateClaudeCodeLog());
    const earningsClient = new EarningsClient(BASE,
      () => auth.accessToken(), fetch, async () => auth.refresh());
    const consentClient = new ConsentClient(BASE, () => auth.accessToken());
    void maybePromptForConsent({
      client: consentClient, ctx, vsc: vscode,
      dlog: (msg) => dlog("ext", "consent", { msg }),
    });
    const ccVersion = pf.version ?? "unknown";
    session.set({ ccVersion });

    // ─── Earnings ───────────────────────────────────────────────────
    // Shared arbiter: statusBarAd sets adBar.adShowing while its ad owns the
    // status-bar item; the earnings refresh consults it so it won't clobber a
    // live ad. Declared here so both subsystems share the one reference.
    const adBar = { adShowing: false };
    const { showActive, scheduleEarningsRefresh } = setupEarningsRefresh(
      auth, earningsClient, session, statusBar, ccVersion, ctx,
      () => adBar.adShowing);

    // ─── Portfolio ──────────────────────────────────────────────────
    const portfolioResp = auth.accessToken()
      ? await portfolio.fetchPortfolio(ccVersion) : null;
    let ad = portfolioResp?.ad ?? null;
    const viewThresholdMs = portfolioResp?.viewThresholdMs ?? 3000;
    session.set({ hasAd: !!ad });

    // Lazy portfolio resolve for the debug closure.
    let pendingPortfolioFetch: Promise<typeof ad> | null = null;
    const resolveAdForBilling = async (): Promise<typeof ad> => {
      if (ad) return ad;
      if (!auth.accessToken()) return null;
      if (pendingPortfolioFetch) return pendingPortfolioFetch;
      pendingPortfolioFetch = (async () => {
        try {
          let r = await portfolio.fetchPortfolio(ccVersion);
          if (!r?.ad) {
            const refreshed = await auth.refresh();
            if (refreshed) r = await portfolio.fetchPortfolio(ccVersion);
          }
          if (r?.ad) {
            ad = r.ad;
            session.set({ hasAd: true, signedIn: true, authHealthy: "ok" });
            debugCtl.setPortfolioAd(r.ad.adText, r.ad.clickUrl || "");
            dlog("ext", "portfolio.lazy_resolved", { adId: r.ad.adId });
          }
          return ad;
        } finally {
          pendingPortfolioFetch = null;
        }
      })();
      return pendingPortfolioFetch;
    };

    // Debug-mode metrics sender.
    if (ad) {
      debugCtl.setPortfolioAd(ad.adText, ad.clickUrl || "");
    }
    debugCtl.setMetricsSender((k, p) => {
      void (async () => {
        const a = await resolveAdForBilling();
        if (!a || !auth.accessToken()) return;
        const debugCorr = "debug." + (a.adId || "no-ad").slice(0, 8)
          + "." + Math.random().toString(36).slice(2, 6);
        const eventUuid = p.eventUuid || newMetricEventUuid();
        dlog("ext", "metric.send", { event: k, adId: a.adId,
          surface: p.surface, visibleMs: p.visibleMs, eventUuid },
          { corr: debugCorr });
        metrics.send(k, {
          adId: a.adId,
          campaignId: a.campaignId,
          ccVersion,
          corr: debugCorr,
          sessionToken: a.sessionToken,
          ...p,
          eventUuid,
        });
        if (k === "view_threshold_met" || k === "click"
            || k === "impression_viewable" || k === "error_impression") {
          scheduleEarningsRefresh();
        }
      })();
    });

    // Block-desync diagnostic state.
    const desyncState: DesyncState = { lastApplyAt: 0, lastBlockStartAt: 0 };

    // Kill-switch state.
    let killed = false;

    // Live ref for the e2e test hooks to read the loopback details after
    // they're minted below. Stays null on builds that never patch the webview.
    let lbInfo: { port: number; base: string } | null = null;

    // Test hooks controller.
    const testHooks = new TestHooks(metrics, portfolio, earningsClient, () => ({
      ad,
      signedIn: !!auth.accessToken(),
      killed,
      ccVersion,
      viewThresholdMs,
      loopback: lbInfo,
    }));

    const checkKill = async () => {
      const ks = override?.killed !== undefined
        ? { killed: override.killed, offline: false }
        : await kill.checkOnce(ccVersion, ad?.campaignId || "");
      killed = ks.killed;
      session.set({ killed });
      if (ks.killed) {
        adapter.restore();
        restoreCodexSafe(codexAdapter);
        actx.cliStatus?.restore();
        statusBar.set({ kind: ks.offline ? "offline" : "killed" });
      }
    };
    await checkKill();

    // ─── Webview injection ──────────────────────────────────────────
    const adRef = { get current() { return ad; }, set current(v) { ad = v; } };
    const killedRef = { get current() { return killed; }, set current(v) { killed = v; } };

    const wvResult = await setupWebviewInjection({
      ctx, actx, adapter, auth, debugCtl, session, portfolio,
      metrics, logTail, testHooks, statusBar, ccVersion,
      killed, killedRef, adRef,
      portfolioResp, viewThresholdMs,
      statusBarShowActive: showActive,
      scheduleEarningsRefresh,
      desyncState,
    });
    lbInfo = wvResult.lbInfo;
    const reapplyCodex = wvResult.reapplyCodex;

    if (ad && override?.killed !== true && webviewMode() === "off") {
      adapter.restore();
      restoreCodexSafe(codexAdapter);
      dlog("ext", "webview.forced-off", {});
    }

    // ─── Guaranteed startup reassert (prime) ────────────────────────
    // Prime the invisible loopback connect-src CSP patch on EVERY boot —
    // even with no ad in hand and even signed out — so the surface is ready
    // the instant an ad arrives (no waiting for the 60s reassert tick or a
    // manual reload). Idempotent + invisible: when an ad was present the
    // applyPatch above already inserted this, so prime() is a cheap no-op.
    // The kill-switch and an off webviewMode still win (prime directive:
    // a killed / opted-out install must never have CC files touched).
    if (!killed && webviewMode() === "on") {
      try { adapter.prime?.(); } catch { /* prime directive */ }
      try { codexAdapter?.prime?.(); } catch { /* prime directive */ }
    }

    // ─── CLI sync ───────────────────────────────────────────────────
    setupCliSync({
      actx, adapter, auth, metrics, debugCtl, ccVersion,
      adRef, killedRef,
      overrideKilled: override?.killed,
      reapplyCodex,
    });

    // ─── Status bar ad ──────────────────────────────────────────────
    setupStatusBarAd({
      logTail,
      metrics,
      statusBar,
      adRef,
      killedRef,
      ccVersion,
      isSignedIn: () => !!auth.accessToken(),
      showActive,
      timers: actx.timers,
      barState: adBar,
    });

    // ─── Periodic timers ────────────────────────────────────────────
    actx.timers.push(setInterval(checkKill, 30_000));
    actx.timers.push(setInterval(() => void showActive(), 30_000));
    actx.timers.push(setInterval(() => void debugCtl?.reassertTick(), 60_000));

    // Tiered desync self-heal. The drift-only reasserts above can't see a
    // "patched file but webview cached the pre-patch module" desync; this
    // watchdog escalates (cyclePatch → webview reload → window-reload toast)
    // ONLY when CC is actively in use (independent transcript-mtime signal)
    // yet our overlay telemetry has gone silent — never when simply idle.
    const hardReassert = (): void => {
      try {
        const c = debugCtl.cyclePatch();        // debug-injection path
        if (!c.ok) wvResult.cycleReassert?.();  // production server-ad path
      } catch { /* prime directive */ }
    };
    setupDesyncDetector(desyncState, actx.timers, {
      ccActivityAgeMs: () => logTail.activityAgeMs(),
      healthy: () => shouldReassert({
        signedIn: !!auth.accessToken(),
        haveAd: !!adRef.current,
        killed: killedRef.current,
      }),
      hardReassert,
    });

    // Login trigger: reassert the patch immediately after a successful
    // interactive sign-in (don't wait up to 60s for the next reassert tick).
    auth.setOnSignedIn(() => {
      try {
        void debugCtl.reapplyIfOn();   // debug-injection path
        hardReassert();                // production path (health-gated no-op if no ad)
      } catch { /* prime directive */ }
    });

    // ─── Command registration ───────────────────────────────────────
    registerCommands(ctx, adapter, codexAdapter, auth, debugCtl, statusBar,
      session, updater, ccVersion, showActive);

    // ─── E2E test hooks ─────────────────────────────────────────────
    if (testHooksEnabled()) {
      testHooks.registerCommands(ctx);
      ctx.subscriptions.push(
        vscode.commands.registerCommand("kickbacks.test.refreshStatusBar",
          async () => { await showActive(); }));
      void vscode.commands.executeCommand(
        "setContext", "kickbacks.test.enabled", true);
      dlog("ext", "testhook.enabled", {});
    }
  } catch (e) {
    try {
      dlog("ext", "activate.fatal", {
        msg: errMsg(e, 300),
        stack: (e instanceof Error && e.stack ? e.stack : "").split("\n")[0],
      });
    } catch { /* dlog itself must never throw */ }
  }
}

export async function deactivate(): Promise<void> {
  for (const t of actx.timers) clearInterval(t);
  actx.timers.length = 0;
  try {
    const canaryPath = join(homedir(), ".vibe-ads", "boot.canary");
    if (existsSync(canaryPath)) unlinkSync(canaryPath);
  } catch { /* best-effort */ }
  const userWantsPatched = !!actx.debugCtl?.on();
  if (actx.loopback) { await actx.loopback.stop(); actx.loopback = null; }
  if (actx.debugCtl) { await actx.debugCtl.dispose(); actx.debugCtl = null; }
  if (!userWantsPatched) {
    try {
      if (actx.ccAdapter) actx.ccAdapter.restore({ keepCsp: true });
      else {
        const target = locateClaudeCode();
        if (target) new ClaudeCodeAdapter(target).restore({ keepCsp: true });
      }
    } catch { /* ignore */ }
  }
  try { actx.cliStatus?.restore(); } catch { /* ignore */ }
  try { actx.codexCliStatus?.restore(); } catch { /* ignore */ }
  if (!userWantsPatched) {
    try {
      if (actx.codexAdapter) actx.codexAdapter.restore({ keepCsp: true });
      else {
        const ct = locateCodexTarget();
        if (ct) new CodexAdapter(ct).restore({ keepCsp: true });
      }
    } catch { /* ignore */ }
  }
  actx.cliStatus = null;
  actx.codexCliStatus = null;
  actx.ccAdapter = null;
  actx.codexAdapter = null;
  override = null;
}
