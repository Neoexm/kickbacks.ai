import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the log module so these tests never touch the real debug log or
// read dev-machine sentinels / env vars that could flip assertions.
vi.mock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
  dlogRaw: () => {}, codexEnabled: () => false, codexCliEnabled: () => false,
  LOG_PATH: "/tmp/test-log" }));

import { AuthClient } from "../src/auth/client";
import { createVault } from "../src/auth/vault";
import { makeContext, _opened } from "./mocks/vscode";

// Hermetic fallback file per test (never touch the real ~/.vibe-ads).
const mkAuthFile = () => join(mkdtempSync(join(tmpdir(), "vibe-ads-auth-")), "auth.json");
// Hermetic vault: an unknown platform => "plain" scheme, so seal/open never
// shell out (fixture-only rule). Per-OS behavior is covered by vault.test.ts.
const noExec = (async () => { throw new Error("no exec in tests"); }) as never;
const pv = () => createVault("test", noExec);

describe("AuthClient", () => {
  it("signIn opens the broker URL then polls until tokens, stores in SecretStorage", async () => {
    const ctx = makeContext();
    let polls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307,
          headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null },
        } as unknown as Response;
      polls++;
      if (polls < 2) return { ok: true, status: 200, json: async () => ({ status: "pending" }) } as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }) } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    await a.signIn();
    expect(_opened.some((u) => u.includes("https://g/auth"))).toBe(true);
    expect(await ctx.secrets.get("kickbacks.access")).toBe("AT");
    expect(await ctx.secrets.get("kickbacks.refresh")).toBe("RT");
    expect(a.accessToken()).toBe("AT");
    expect(a.signedIn()).toBe(true);
  });

  it("refresh swaps access AND persists the rotated refresh token", async () => {
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.refresh", "RT");
    const f = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh"))
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }) } as Response;
      return { ok: false, status: 500 } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    expect(await a.refresh()).toBe(true);
    expect(a.accessToken()).toBe("AT2");
    expect(await ctx.secrets.get("kickbacks.refresh")).toBe("RT2"); // rotation persisted
  });

  it("single-flights concurrent refresh() calls so the rotating token is consumed once", async () => {
    // Two callers (status-bar earnings 401 + portfolio 401) racing on the
    // SAME refresh token used to double-POST /refresh; S1 rotates on first
    // use, so the second call sent a consumed token, 401'd, and nulled `at`
    // — clobbering the first call's success. Single-flight must collapse
    // them to ONE request.
    const s = new Map<string, string>(), g = new Map<string, unknown>();
    const ctx = {
      secrets: { get: async (k: string) => s.get(k),
        store: async (k: string, v: string) => { s.set(k, v); },
        delete: async (k: string) => { s.delete(k); } },
      globalState: { get: (k: string) => g.get(k),
        update: async (k: string, v: unknown) => { g.set(k, v); } },
      subscriptions: [],
    };
    await ctx.secrets.store("kickbacks.refresh", "RT");
    let calls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh")) {
        calls++;
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT2", refresh_token: "RT2" }) } as Response;
      }
      return { ok: false, status: 500 } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    const [r1, r2] = await Promise.all([a.refresh(), a.refresh()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(calls).toBe(1);                 // one POST, not two
    expect(a.accessToken()).toBe("AT2");
  });

  it("refresh() recovers the token from the sealed file when SecretStorage is empty", async () => {
    // Reinstall / keyring-less: secrets holds nothing, but a prior signIn
    // sealed the token to the durable file. refresh() (called WITHOUT an
    // explicit token, e.g. via a 401 retry) must find it there.
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const signInF = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a1 = new AuthClient("http://b", isoCtx() as never, signInF as never, 0, file, pv());
    await a1.signIn();                      // seals plain:1:RT to `file`

    const refreshF = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT3", refresh_token: "RT3" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a2 = new AuthClient("http://b", isoCtx() as never, refreshF as never, 0, file, pv());
    expect(await a2.refresh()).toBe(true);  // empty secrets -> file fallback
    expect(a2.accessToken()).toBe("AT3");
  });

  it("fires the onSignedIn login trigger after a successful interactive sign-in", async () => {
    const ctx = makeContext();
    let fired = 0;
    const f = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    a.setOnSignedIn(() => { fired++; });
    await a.signIn();
    expect(fired).toBe(1);                 // login trigger → immediate reassert
  });

  it("always-writes a sealed envelope to the file (the keyring-less Linux fix)", async () => {
    const file = mkAuthFile();
    const ctx = makeContext();
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, file, pv());
    await a.signIn();
    const fb = JSON.parse(readFileSync(file, "utf8"));
    expect(fb.refresh).toBe("plain:1:RT");        // sealed envelope, not bare token
    expect(fb.refresh).not.toBe("RT");
  });

  it("survives a reinstall: empty SecretStorage recovers via the sealed file", async () => {
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const ctx1 = isoCtx();
    const f1 = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a1 = new AuthClient("http://b", ctx1 as never, f1 as never, 0, file, pv());
    await a1.signIn();

    const ctx2 = isoCtx(); // brand-new namespace (= reinstall/rename)
    const f2 = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh"))
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT-NEW", refresh_token: "RT2" }) } as Response;
      return { ok: false, status: 500 } as Response;
    });
    const a2 = new AuthClient("http://b", ctx2 as never, f2 as never, 0, file, pv());
    expect(a2.accessToken()).toBeNull();
    await a2.loadCached();
    expect(a2.accessToken()).toBe("AT-NEW");                 // no re-sign-in
  });

  it("upgrades a PRE-VAULT plaintext refresh token in place on first read", async () => {
    // Isolated ctx — makeContext() shares a module-global secrets Map, which
    // would leak a prior test's tokens and skip the file-recovery path.
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    // Simulate an older build's file: bare token, no envelope prefix.
    const seed = new AuthClient("http://b", isoCtx() as never, (async () => ({})) as never, 0, file, pv());
    const cid = seed.clientId();
    require("node:fs").writeFileSync(file,
      JSON.stringify({ refresh: "LEGACY-RT", clientId: cid }));
    const f = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT", refresh_token: "RT2" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a = new AuthClient("http://b", isoCtx() as never, f as never, 0, file, pv());
    await a.loadCached();
    expect(a.accessToken()).toBe("AT");                       // legacy token still worked
    const fb = JSON.parse(readFileSync(file, "utf8"));
    expect(fb.refresh.startsWith("plain:1:")).toBe(true);     // re-sealed (upgraded)
  });

  it("signOut clears all stores incl. the OS vault entry; no silent re-mint", async () => {
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const vault = pv();
    const clearSpy = vi.spyOn(vault, "clear");
    const ctx1 = isoCtx();
    const f1 = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a1 = new AuthClient("http://b", ctx1 as never, f1 as never, 0, file, vault);
    await a1.signIn();
    const id1 = a1.clientId();
    expect(a1.signedIn()).toBe(true);

    await a1.signOut();
    expect(a1.signedIn()).toBe(false);
    expect(a1.accessToken()).toBeNull();
    expect(clearSpy).toHaveBeenCalled();                      // OS-store entry purged
    expect(JSON.parse(readFileSync(file, "utf8")).refresh).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).clientId).toBe(id1); // anon id kept

    const ctx2 = isoCtx(); // reinstall after sign-out MUST stay signed out
    const a2 = new AuthClient("http://b", ctx2 as never,
      (async () => ({ ok: false, status: 500 })) as never, 0, file, pv());
    await a2.loadCached();
    expect(a2.accessToken()).toBeNull();
    expect(a2.clientId()).toBe(id1);
  });

  it("clientId is a stable persisted anon id (survives a fresh ctx via file)", async () => {
    const file = mkAuthFile();
    const a1 = new AuthClient("http://b", makeContext() as never, (async () => ({})) as never, 0, file, pv());
    const id1 = a1.clientId();
    expect(id1.length).toBeGreaterThanOrEqual(16);
    const a2 = new AuthClient("http://b", makeContext() as never, (async () => ({})) as never, 0, file, pv());
    expect(a2.clientId()).toBe(id1);
  });

  it("storageInfo reports the active scheme + keyring health", async () => {
    const ctx = makeContext();
    const a = new AuthClient("http://b", ctx as never,
      (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) })) as never,
      0, mkAuthFile(), pv());
    expect(a.storageInfo().scheme).toBe("plain");
    expect(a.storageInfo().keyringDurable).toBeUndefined();    // not probed yet
  });
});

// audit BL-015 (wave-2A H1 coverage): a refresh() failure must clear the
// in-memory access token so signedIn() flips to false at the right moment.
// Pre-fix a dead token lingered until explicit signOut() and every backend
// call 401'd while signedIn() still reported true.
describe("AuthClient refresh failure clears session (H1)", () => {
  it("H1: refresh() with no stored token clears in-memory `at`", async () => {
    vi.resetModules();
    vi.doMock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
      dlogRaw: () => {}, codexEnabled: () => false,
      LOG_PATH: "/tmp/t" }));
    const { AuthClient: AC } = await import("../src/auth/client");
    const ctx = makeContext();
    // Seed with a "dead" access token (no refresh token in storage).
    await ctx.secrets.store("kickbacks.access", "DEAD");
    const a = new AC("http://localhost:6080", ctx as never,
      (async () => ({ ok: false, status: 401 })) as never,
      0, mkAuthFile(), pv());
    await a.loadCached();                       // pulls DEAD into this.at
    expect(a.accessToken()).toBe("DEAD");       // pre-fix behavior persists
    const refreshed = await a.refresh();         // no refresh token -> false
    expect(refreshed).toBe(false);
    // Post-fix: at is cleared, so signedIn() flips to false.
    expect(a.accessToken()).toBeNull();
    expect(a.signedIn()).toBe(false);
    vi.doUnmock("../src/log");
    vi.resetModules();
  });
});
