import * as vscode from "vscode";
import { buildLabel } from "./buildinfo";

export type SbState =
  | { kind: "signed-out" }
  | { kind: "active"; version: string; usd?: string; usdToday?: string }
  | { kind: "incompatible"; version: string }
  | { kind: "killed" }
  | { kind: "offline" }
  // `debug` renders exactly like `active` (the word "debug" is intentionally
  // never surfaced in the status-bar text — operator-facing detail only).
  | { kind: "debug"; on: boolean; version?: string; usd?: string; usdToday?: string }
  | { kind: "ad"; adText: string };

// Darker than the previous #3fb950 (GitHub success-emphasis green) so it
// reads as confident-earning rather than a bright neon stripe.
const GREEN = "#2ea043";
// Used for states where the extension isn't earning (signed-out, injection
// toggled off, kill-switch engaged, backend offline). Sits at the same
// confidence level as GREEN — bright enough to flag the state at a glance
// in the status bar without being a "broken" red.
const RED = "#f85149";

export class StatusBar {
  // Right-aligned (priority high so it sits toward the leading edge of the
  // right cluster).
  private item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 1000);
  text = "";
  constructor() { this.item.command = "kickbacks.debugMenu"; this.item.show(); }

  // Always render the two-figure form. A missing figure (fetch failed, or
  // signed-in before the first /v1/earnings poll) degrades to "$0.00" — the
  // signed-in/active bar never shows a bare label. Note: a fetch failure is
  // therefore indistinguishable from genuine zero earnings (deliberate, per
  // product call — prefer always showing a dollar figure).
  private earned(usd?: string, today?: string): string {
    return ` ($${today ?? "0.00"} today · $${usd ?? "0.00"})`;
  }

  set(s: SbState): void {
    let color: string | undefined;
    let tooltip = "Kickbacks";
    switch (s.kind) {
      case "signed-out":
        // No icon — the "K" codicon doesn't exist in VS Code's default set,
        // and a generic glyph would misrepresent the brand. Text only.
        // RED to flag the not-earning state at a glance.
        this.text = "Kickbacks: Sign in";
        color = RED;
        tooltip = "Click to sign in to Kickbacks";
        break;
      case "active":
        this.text = `Kickbacks${this.earned(s.usd, s.usdToday)}`;
        color = GREEN;
        tooltip = `Kickbacks active${s.version ? ` · Claude Code ${s.version}` : ""}`
          + ` · $${s.usdToday ?? "0.00"} today · $${s.usd ?? "0.00"} earned`
          + " (display-only credit, payout TBD)";
        break;
      case "debug":
        // Signed-in/debug: green when ON, red when OFF (user has the menu
        // master switch flipped off — earnings paused).
        if (s.on === false) {
          this.text = "Kickbacks: Off";
          color = RED;
          tooltip = "Kickbacks is currently OFF — click to re-enable";
        } else {
          this.text = `Kickbacks${this.earned(s.usd, s.usdToday)}`;
          color = GREEN;
          tooltip = `Kickbacks active${s.version ? ` · Claude Code ${s.version}` : ""}`
            + ` · $${s.usdToday ?? "0.00"} today · $${s.usd ?? "0.00"} earned`
            + " (display-only credit, payout TBD)";
        }
        break;
      case "incompatible":
        this.text = `Kickbacks incompatible (${s.version})`;
        break;
      case "killed":
        this.text = "Kickbacks killed";
        color = RED;
        break;
      case "offline":
        this.text = "Kickbacks offline";
        color = RED;
        break;
      case "ad":
        this.text = s.adText;
        color = GREEN;
        tooltip = "Kickbacks ad";
        break;
    }
    // The click always opens the menu; sign in / sign out is the menu's top
    // item, flipping by auth state (so it's reachable signed-out too).
    this.item.command = "kickbacks.debugMenu";
    this.item.color = color;
    // Live build age in the tooltip — the truthful "how long ago published"
    // the VS Code Installation panel can't show (it's not author-extensible).
    this.item.tooltip = `${tooltip} · ${buildLabel()}`;
    this.item.text = this.text;
  }
  dispose(): void { this.item.dispose(); }
}
