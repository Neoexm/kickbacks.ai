import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import type { DebugController } from "../debug";
import type { TargetAdapter } from "../adapters/types";
import { dlog } from "../log";
import { errMsg } from "../util/errMsg";

const CANARY_PATH = join(homedir(), ".vibe-ads", "boot.canary");
const SETTLE_MS = 5_000;
const CANARY_STALE_MS = 90 * 1000;
const FIRST_RUN_KEY = "kickbacks.firstRun.completed";

export async function setupBootCanary(
  adapter: TargetAdapter,
  debugCtl: DebugController,
  ctx: vscode.ExtensionContext,
): Promise<void> {
  let canaryFromCrash = false;
  try {
    if (existsSync(CANARY_PATH)) {
      const age = Date.now() - statSync(CANARY_PATH).mtimeMs;
      if (age < CANARY_STALE_MS) canaryFromCrash = true;
    }
  } catch { /* ignore */ }

  if (canaryFromCrash) {
    dlog("ext", "boot.canary.skip", {
      reason: "prior activation didn't settle (likely VS Code crash mid-patch)" });
    try {
      await vscode.window.showWarningMessage?.(
        "Kickbacks: prior activation didn't complete cleanly — skipping " +
        "automatic patch this run. Click the status bar to manually " +
        "re-enable once you're sure VS Code is stable.");
    } catch { /* no-op (test mock may lack showWarningMessage) */ }
  } else {
    try {
      mkdirSync(join(homedir(), ".vibe-ads"), { recursive: true });
      writeFileSync(CANARY_PATH, String(Date.now()));
    } catch { /* canary is best-effort */ }

    try {
      const pfBoot = adapter.preflight();
      if (pfBoot.compatible && !debugCtl.on()) {
        await debugCtl.setOn(true);
        dlog("ext", "boot.autoenable", { applied: true });
      }
      if (ctx.globalState.get<boolean>(FIRST_RUN_KEY) !== true) {
        await ctx.globalState.update(FIRST_RUN_KEY, true);
      }
    } catch (e) {
      dlog("ext", "boot.autoenable.error",
        { msg: errMsg(e) });
    }

    await debugCtl.reapplyIfOn();

    try {
      const cycleKill = join(homedir(), ".vibe-ads", "no-boot-cycle.enabled");
      if (existsSync(cycleKill)) {
        dlog("ext", "boot.cycle.skip", { reason: "sentinel" });
      } else {
        dlog("ext", "boot.cycle.start", {});
        const r = debugCtl.cyclePatch();
        dlog("ext", "boot.cycle.done", { ok: r.ok, reason: r.reason });
      }
    } catch (e) {
      dlog("ext", "boot.cycle.error",
        { msg: errMsg(e) });
    }
  }

  // Clear the canary once VS Code has been alive for SETTLE_MS.
  setTimeout(() => {
    try { unlinkSync(CANARY_PATH); } catch { /* ignore */ }
  }, SETTLE_MS).unref?.();
}
