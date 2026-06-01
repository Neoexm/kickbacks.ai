import { describe, it, expect, vi } from "vitest";
import { DebugController } from "../src/debug";
import { makeContext, window, commands } from "./mocks/vscode";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function authHook(signedIn: boolean) {
  return {
    signedIn: () => signedIn,
    storageInfo: () => ({ scheme: "file" }),
    signOut: vi.fn(async () => {}),
  };
}

function mkAdapter() {
  return {
    name: "claude-code",
    preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
    version: () => "2.1.143",
    applyPatch: vi.fn(() => ({ ok: true })),
    restore: vi.fn(() => ({ ok: true, restored: true })),
  };
}

describe("DebugController", () => {
  it("defaults to off with a default message", () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    expect(d.on()).toBe(false);
    expect(d.text()).toMatch(/kickbacks/i);
  });

  it("setOn(true) patches with the custom text and reports state", async () => {
    const adapter = mkAdapter();
    const ctx = makeContext() as never;
    const onState = vi.fn();
    const d = new DebugController(adapter, ctx, onState);
    await d.setText("Hello from debug");
    await d.setOn(true);
    expect(d.on()).toBe(true);
    expect(adapter.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({ adText: "Hello from debug", tier: 3 }));
    expect(onState).toHaveBeenCalledWith(true);
    await d.dispose();
  });

  it("setOn(false) restores and reports state", async () => {
    const adapter = mkAdapter();
    const onState = vi.fn();
    const d = new DebugController(adapter, makeContext() as never, onState);
    await d.setOn(false);
    expect(adapter.restore).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith(false);
  });

  it("reassertTick re-applies when ON but the patch drifted (Bug B)", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => false) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setOn(true);                  // persists ON (applies once)
    adapter.applyPatch.mockClear();
    await d.reassertTick();
    expect(adapter.applyPatch).toHaveBeenCalled();   // self-healed, no toggle
    await d.dispose();
  });

  it("reassertTick is a no-op when ON and the patch is still present", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => true) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setOn(true);
    adapter.applyPatch.mockClear();
    await d.reassertTick();
    expect(adapter.applyPatch).not.toHaveBeenCalled(); // healthy => no churn
    await d.dispose();
  });

  it("reassertTick is a no-op when injection is OFF", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => false) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.reassertTick();              // never turned on
    expect(adapter.applyPatch).not.toHaveBeenCalled();
  });

  it("menu's top item is 'Sign in' when signed out; runs the signIn command", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(false));
    let captured: { id: string; label: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id: string; label: string }[];
        return captured.find((i) => i.id === "signin");
      });
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    expect(captured[0].id).toBe("signin");
    expect(captured[0].label).toMatch(/sign in/i);
    expect(captured.some((i) => i.id === "signout")).toBe(false);
    expect(exec).toHaveBeenCalledWith("kickbacks.signIn");
    qp.mockRestore(); exec.mockRestore();
  });

  it("menu's top item flips between Sign in / Sign out by auth state and dispatches the right command", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    let captured: { id: string; label: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id: string; label: string }[];
        return captured.find((i) => i.id === "signout");
      });
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    // Top row is the signed-in user's Sign out action — the identity
    // appears INLINE (label or description), not as a separate row.
    // signin must NOT appear when already signed in.
    expect(captured[0].id).toBe("signout");
    expect(captured[0].label).toMatch(/sign out/i);
    expect(captured.some((i) => i.id === "signin")).toBe(false);
    expect(captured.some((i) => i.id === "__identity")).toBe(false);
    expect(exec).toHaveBeenCalledWith("kickbacks.signOut");
    qp.mockRestore(); exec.mockRestore();
  });

  it("W2 menu shape: required items present, deprecated ones absent", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    let captured: { id?: string; label?: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id?: string; label?: string }[]; return undefined;
      });
    await d.openMenu();
    const ids = captured.map((i) => i.id);
    // Required
    expect(ids).toContain("toggle");
    expect(ids).toContain("config");
    expect(ids).toContain("reapply");
    expect(ids).toContain("reload");
    expect(ids).toContain("restore");
    expect(ids).toContain("openlog");
    expect(ids).toContain("builtinfo");
    // Removed: msg (rolled into config.json), plus W2-era wv/cli/diag/banner/status
    expect(ids).not.toContain("msg");
    expect(ids).not.toContain("wv");
    expect(ids).not.toContain("cli");
    expect(ids).not.toContain("diag");
    expect(ids).not.toContain("banner");
    expect(ids).not.toContain("status");
    // Toggle label reflects state
    const toggleLabel = captured.find((i) => i.id === "toggle")?.label || "";
    expect(toggleLabel).toMatch(/enable|disable/i);
    expect(toggleLabel).toMatch(/kickbacks/i);
    qp.mockRestore();
  });

  it("consolidated re-apply fires BOTH CC reassert and Codex reassert", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    const ccReassert = vi.fn();
    const codexReassert = vi.fn();
    d.setReassert(ccReassert);
    d.setReassertCodex(codexReassert);
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "reapply"));
    await d.openMenu();
    expect(ccReassert).toHaveBeenCalled();
    expect(codexReassert).toHaveBeenCalled();
    qp.mockRestore();
  });

  it("menu omits the auth item entirely when auth is unavailable", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    let captured: { id: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => { captured = items as { id: string }[]; return undefined; });
    await d.openMenu();
    expect(captured.some((i) => i.id === "signin" || i.id === "signout")).toBe(false);
    qp.mockRestore();
  });

  it("setText live re-applies only while injection is on", async () => {
    const adapter = mkAdapter();
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setText("off-text");
    expect(adapter.applyPatch).not.toHaveBeenCalled();
    await d.setOn(true);
    await d.setText("on-text");
    expect(adapter.applyPatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ adText: "on-text" }));
    await d.dispose();
  });

  // ─── Tiered auto-enable across sign-out → sign-in ─────────────────────
  // Regression: signing out forces K_ON=false; pre-fix the sign-in gate only
  // re-enabled on neverToggled(), so once you'd signed out you stayed disabled
  // forever. doSignOut() now remembers the pre-sign-out state so the next
  // sign-in can restore it — while still respecting a deliberate disable.
  it("shouldAutoEnableOnSignIn: Tier 1 — true for a first-run user (never toggled)", () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    expect(d.neverToggled()).toBe(true);
    expect(d.shouldAutoEnableOnSignIn()).toBe(true);
  });

  it("shouldAutoEnableOnSignIn: Tier 2 — true after signing out while injection was ON", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);            // user is running ads
    await d.doSignOut();            // forces K_ON=false, remembers it was ON
    expect(d.on()).toBe(false);
    expect(d.neverToggled()).toBe(false);          // K_ON is defined now
    expect(d.shouldAutoEnableOnSignIn()).toBe(true); // …but Tier 2 fires
    await d.dispose();
  });

  it("shouldAutoEnableOnSignIn: false when the user deliberately disabled, then signed out", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.setOn(false);          // deliberate "Disable Kickbacks"
    await d.doSignOut();           // captures the OFF intent
    expect(d.shouldAutoEnableOnSignIn()).toBe(false); // stays off — respected
    await d.dispose();
  });

  it("clearSignOutMemory consumes the one-shot intent", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.doSignOut();
    expect(d.shouldAutoEnableOnSignIn()).toBe(true);
    await d.clearSignOutMemory();
    // Flag gone; only the (still-false) K_ON remains, so no auto-enable.
    expect(d.shouldAutoEnableOnSignIn()).toBe(false);
    await d.dispose();
  });

  it("bannerOverride cycles server → on → off → server (modes sentinel)", async () => {
    const RH = process.env.HOME, RU = process.env.USERPROFILE;
    const tmp = mkdtempSync(join(tmpdir(), "vibe-dbg-"));
    process.env.HOME = tmp; process.env.USERPROFILE = tmp;
    try {
      const ctl = new DebugController(mkAdapter(), makeContext() as never, () => {});
      expect(ctl.bannerOverride()).toBe("server");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("on");
      expect(readFileSync(join(tmp, ".vibe-ads", "banner.mode"), "utf8").trim()).toBe("on");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("off");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("server");
      expect(existsSync(join(tmp, ".vibe-ads", "banner.mode"))).toBe(false);
    } finally {
      if (RH !== undefined) process.env.HOME = RH; else delete process.env.HOME;
      if (RU !== undefined) process.env.USERPROFILE = RU; else delete process.env.USERPROFILE;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("DebugController — restart/open-log routing (W2 menu)", () => {
  function mkDbg() {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    return d;
  }

  it("reload entry restarts the extension host", async () => {
    const d = mkDbg();
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "reload"));
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    expect(exec).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    qp.mockRestore(); exec.mockRestore();
  });

  it("openlog entry opens the debug log file", async () => {
    const d = mkDbg();
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "openlog"));
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    expect(exec).toHaveBeenCalledWith("vscode.open", expect.anything());
    qp.mockRestore(); exec.mockRestore();
  });
});
