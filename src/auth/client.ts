import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createVault, type SecretVault } from "./vault";
import { dlog } from "../log";

type Fetch = typeof fetch;
// kickbacks.* are the current keys; vibe-ads.* are legacy (pre-W1-rename)
// and read-through-only — copied forward on first access so the user's stable
// device id, refresh token, and access token survive the rename. We never
// DELETE the legacy entries; that way a downgrade still finds a session.
const A = "kickbacks.access", R = "kickbacks.refresh", CID = "kickbacks.clientId";
const A_LEGACY = "vibe-ads.access", R_LEGACY = "vibe-ads.refresh";
const CID_LEGACY = "vibe-ads.clientId";
// A vault-sealed refresh value; anything NOT matching is a pre-vault legacy
// plaintext token written by an older build (upgraded in place on first read).
const ENVELOPE = /^(plain|keychain|dpapi|libsecret):1:/;

interface Fallback { refresh?: string; clientId?: string }

/** S1 backend-brokered sign-in. Cross-platform persistence is LAYERED:
 *
 *   1. VS Code SecretStorage (ctx.secrets) — fast cache. Durable on macOS/
 *      Windows; a coin-flip on Linux (no Secret Service on headless/WSL/
 *      devcontainer/Remote-SSH). NEVER the source of truth.
 *   2. id-independent home file (~/.vibe-ads/auth.json, 0600) — the universal
 *      floor; behaves identically on all 3 OSes and survives reinstall/rename.
 *      The refresh token in it is sealed by `SecretVault` (Keychain on macOS,
 *      DPAPI on Windows, libsecret on Linux, plaintext floor otherwise).
 *
 *  The file is ALWAYS written when we hold a refresh token (the old `if
 *  (refresh)`-only bug created the "signed in last session but shows signed
 *  out" gap on keyring-less Linux). S1's refresh role/email loss is ACCEPTED. */
export class AuthClient {
  private at: string | null = null;
  private keyringOk: boolean | undefined; // set by the post-store read-back
  // Single-flight guard: coalesce concurrent refresh() callers (status-bar
  // earnings 401 + portfolio 401 + the load-time re-mint) onto ONE in-flight
  // request. S1 ROTATES (consumes) the refresh token, so two parallel
  // refreshes race — the first rotates the token, the second sends the
  // now-consumed token, 401s, and nulls `at`, clobbering the first call's
  // success. That race is the most likely cause of "signed out after a
  // self-update restart".
  private refreshInFlight: Promise<boolean> | null = null;
  // Login trigger: fired once on a successful interactive sign-in so the
  // injection patch is reasserted immediately rather than waiting up to 60s
  // for the next reassert tick. Wired by extension.ts; no-op until then.
  private onSignedIn: (() => void) | null = null;
  setOnSignedIn(fn: () => void): void { this.onSignedIn = fn; }
  constructor(private base: string,
              private ctx: vscode.ExtensionContext,
              private f: Fetch = fetch,
              private pollMs = 1500,
              // ~/.kickbacks/auth.json is the new universal floor. If only the
              // legacy ~/.vibe-ads/auth.json exists we migrate-on-read inside
              // readFallback(); the legacy file is left in place for downgrade.
              private authFile = join(homedir(), ".kickbacks", "auth.json"),
              private vault: SecretVault = createVault(process.platform),
              // Defined AFTER `vault` to preserve the constructor's positional
              // parameter order — existing call sites that pass `vault` as the
              // 6th arg keep working without test churn.
              private legacyAuthFile = join(homedir(), ".vibe-ads", "auth.json")) {}

  accessToken(): string | null { return this.at; }
  signedIn(): boolean { return this.at != null; }

  /** For `vibe-ads.status` / debug menu: which at-rest scheme is in use and
   *  whether the OS keyring actually round-tripped (the original "didn't catch
   *  that I was signed in" was an undetected keyring-less environment). */
  storageInfo(): { scheme: string; keyringDurable?: boolean } {
    return { scheme: this.vault.scheme(), keyringDurable: this.keyringOk };
  }

  /** Full sign-out. Must clear EVERY place a session can be recovered from or
   *  loadCached() silently re-mints and the user can never log out: in-memory
   *  token, both SecretStorage keys, the OS-store entry behind the envelope
   *  (Keychain/libsecret), AND the refresh field in the file. The stable anon
   *  clientId is intentionally KEPT (device id, not auth). Never throws. */
  async signOut(): Promise<void> {
    this.at = null;
    const env = this.readFallback().refresh;
    try { await this.ctx.secrets.delete(A); } catch { /* best-effort */ }
    try { await this.ctx.secrets.delete(R); } catch { /* best-effort */ }
    // Also clear legacy vibe-ads.* keys so a stale token can't re-sign-in.
    try { await this.ctx.secrets.delete(A_LEGACY); } catch { /* best-effort */ }
    try { await this.ctx.secrets.delete(R_LEGACY); } catch { /* best-effort */ }
    if (env && ENVELOPE.test(env)) {
      try { await this.vault.clear(env); } catch { /* best-effort */ }
    }
    try {
      const fb = this.readFallback();
      delete fb.refresh;                       // keep clientId
      mkdirSync(join(this.authFile, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.authFile, JSON.stringify(fb), { mode: 0o600 });
      try { chmodSync(this.authFile, 0o600); } catch { /* best-effort */ }
    } catch { /* mirror clear is best-effort; never break the extension */ }
    dlog("ext", "auth.signout", {});
  }

  // --- id-independent fallback (best-effort; never throws) -----------------
  private readFallback(): Fallback {
    try { return JSON.parse(readFileSync(this.authFile, "utf8")) as Fallback; }
    catch { /* fall through to legacy */ }
    try { return JSON.parse(readFileSync(this.legacyAuthFile, "utf8")) as Fallback; }
    catch { return {}; }
  }
  private writeFallback(patch: Fallback): void {
    try {
      const merged = { ...this.readFallback(), ...patch };
      mkdirSync(join(this.authFile, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.authFile, JSON.stringify(merged), { mode: 0o600 });
      try { chmodSync(this.authFile, 0o600); } catch { /* best-effort */ }
    } catch { /* persistence is best-effort; never break the extension */ }
  }

  clientId(): string {
    let id = this.ctx.globalState.get<string>(CID)
      || this.ctx.globalState.get<string>(CID_LEGACY)  // W1: pre-rename users
      || this.readFallback().clientId;
    if (!id) id = randomBytes(12).toString("hex");
    this.ctx.globalState.update(CID, id);
    this.writeFallback({ clientId: id });   // stable across reinstall/rename
    return id;
  }

  async loadCached(): Promise<void> {
    // W1 rename: try kickbacks.* first, fall back to legacy vibe-ads.* keys.
    this.at = (await this.ctx.secrets.get(A))
      || (await this.ctx.secrets.get(A_LEGACY))
      || null;
    // Recover the refresh token from the id-independent file if the
    // SecretStorage namespace was lost (reinstall / rename / keyring-less).
    let rt = (await this.ctx.secrets.get(R))
      || (await this.ctx.secrets.get(R_LEGACY)) || undefined;
    let rtSource = rt ? "secrets" : "none";
    if (!rt) {
      const stored = this.readFallback().refresh;
      if (stored && ENVELOPE.test(stored)) {
        rt = (await this.vault.open(stored)) || undefined; // sealed (current)
      } else if (stored) {
        // Pre-vault plaintext token from an older build: use it, then
        // upgrade-in-place by re-sealing through the vault.
        rt = stored;
        await this.sealToFile(rt);
      }
      if (rt) { rtSource = "file"; await this.ctx.secrets.store(R, rt); } // re-warm
    }
    // No access token but we have a refresh token => re-mint silently
    // (this is what makes a reinstall NOT require a new Google sign-in).
    // Hand the recovered token to refresh() EXPLICITLY: relying on it to
    // re-read ctx.secrets is the gap that breaks recovery when the store()
    // above doesn't durably round-trip in the same activation (keyring-less
    // box / fresh post-reinstall namespace).
    if (!this.at && rt) await this.refresh(rt);
    dlog("ext", "auth.loadCached",
      { hadAccess: this.at != null, refreshSource: rtSource,
        signedIn: this.signedIn() });
  }

  /** Seal a refresh token via the OS-native vault and ALWAYS persist the
   *  resulting envelope to the universal file. Best-effort; never throws. */
  private async sealToFile(refresh: string): Promise<void> {
    try {
      const env = await this.vault.seal(this.clientId(), refresh);
      this.writeFallback({ refresh: env });
    } catch { /* persistence is best-effort; never break the extension */ }
  }

  private async persistTokens(access: string, refresh?: string): Promise<void> {
    this.at = access;
    await this.ctx.secrets.store(A, access);
    // Keyring health probe: if the store doesn't round-trip we're in a
    // keyring-less env and the file (above-vault) is doing the real work.
    try { this.keyringOk = (await this.ctx.secrets.get(A)) === access; }
    catch { this.keyringOk = false; }
    if (refresh) {
      try { await this.ctx.secrets.store(R, refresh); } catch { /* cache only */ }
      await this.sealToFile(refresh); // ALWAYS — the durable source of truth
    }
  }

  async signIn(): Promise<boolean> {
    try {
      // S1 contract (see tools/ext_auth_harness.py): /extension/start 307-
      // redirects to Google with `state` embedded in the Location URL. Do NOT
      // follow the redirect (must not fetch Google's HTML) — read Location,
      // open it in the system browser, poll with the parsed state.
      const start = await this.f(`${this.base}/v1/auth/extension/start`,
        { redirect: "manual" } as RequestInit);
      const loc = start.headers.get("location");
      if (!loc) { dlog("ext", "auth.signin", { ok: false, reason: "no-location" }); return false; }
      const state = new URL(loc).searchParams.get("state");
      if (!state) { dlog("ext", "auth.signin", { ok: false, reason: "no-state" }); return false; }
      await vscode.env.openExternal(vscode.Uri.parse(loc));
      for (let i = 0; i < 120; i++) {
        const r = await this.f(
          `${this.base}/v1/auth/extension/poll?state=${encodeURIComponent(state)}`);
        const j = await r.json() as { status?: string; access_token?: string;
          refresh_token?: string };
        if (j.access_token) {
          await this.persistTokens(j.access_token, j.refresh_token);
          dlog("ext", "auth.signin", { ok: true });
          try { this.onSignedIn?.(); } catch { /* trigger is best-effort */ }
          return true;
        }
        await new Promise((res) => setTimeout(res, this.pollMs));
      }
      dlog("ext", "auth.signin", { ok: false, reason: "timeout" });
      vscode.window.showErrorMessage(
        "Vibe-Ads sign-in timed out: no token after polling. " +
        "Did you complete the Google consent in the browser?");
      return false;
    } catch (e) {
      dlog("ext", "auth.signin", { ok: false, reason: "error" });
      vscode.window.showErrorMessage(
        `Vibe-Ads sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Re-mint the access token from the refresh token. Concurrent callers are
   *  coalesced (single-flight) so the rotating refresh token is consumed at
   *  most once per cycle. `explicitRt` lets loadCached() hand the just-
   *  recovered token straight in, bypassing a SecretStorage round-trip that
   *  may not have landed yet. Never throws. */
  async refresh(explicitRt?: string): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this._refresh(explicitRt);
    this.refreshInFlight = p;
    try { return await p; }
    finally { if (this.refreshInFlight === p) this.refreshInFlight = null; }
  }

  private async _refresh(explicitRt?: string): Promise<boolean> {
    // wave-2A-H1: every failure path below clears `this.at`. Pre-fix, a
    // dead access token sat in memory until explicit signOut(); signedIn()
    // returned true but every backend call 401'd. With at cleared on
    // refresh failure, signedIn() flips to false at the right moment.
    try {
      // Token source order: an explicitly-handed token (load-time recovery),
      // then the fast SecretStorage cache, then the durable sealed file. The
      // file fallback closes the gap where secrets is empty/stale (reinstall,
      // keyring-less) but the file still holds a usable — possibly newer —
      // token (e.g. a prior store() silently failed but sealToFile() landed).
      let rt = explicitRt || (await this.ctx.secrets.get(R)) || undefined;
      if (!rt) {
        const stored = this.readFallback().refresh;
        if (stored && ENVELOPE.test(stored)) rt = (await this.vault.open(stored)) || undefined;
        else if (stored) rt = stored;
      }
      if (!rt) {
        this.at = null;
        dlog("ext", "auth.refresh", { ok: false, reason: "no-token" });
        return false;
      }
      const r = await this.f(`${this.base}/v1/auth/refresh`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) {
        this.at = null;
        dlog("ext", "auth.refresh", { ok: false, reason: `http-${r.status}` });
        return false;
      }
      const j = await r.json() as { access_token?: string; refresh_token?: string };
      if (!j.access_token) {
        this.at = null;
        dlog("ext", "auth.refresh", { ok: false, reason: "no-access-token" });
        return false;
      }
      // S1 /refresh ROTATES the refresh token (consume + reissue); persist the
      // new one or the next refresh fails with a consumed token.
      await this.persistTokens(j.access_token, j.refresh_token);
      dlog("ext", "auth.refresh", { ok: true, rotated: !!j.refresh_token });
      return true;
    } catch {
      this.at = null;
      dlog("ext", "auth.refresh", { ok: false, reason: "throw" });
      return false;
    }
  }
}
