import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, statSync } from "node:fs";

// readdir-based glob for `<root>/anthropic.claude-code-*/webview/index.js`.
// Swapped from `node:fs`'s `globSync` (the installed @types/node@20 lacks the
// declaration though Node 22 has it at runtime). Returns absolute paths; never throws.
export function globClaudeCode(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const name of readdirSync(root)) {
      if (!name.startsWith("anthropic.claude-code-")) continue;
      const idx = join(root, name, "webview", "index.js");
      if (existsSync(idx)) out.push(idx);
    }
    return out;
  } catch { return []; }
}

export function locateClaudeCode(): string | null {
  // Explicit escape hatch for S5 matrix / manual smoke / portable installs.
  const explicit = process.env.KICKBACKS_CC_TARGET
    || process.env.VIBE_ADS_CC_TARGET;
  if (explicit && existsSync(explicit)) return explicit;
  // Covers local (.vscode/.cursor) AND remote/server hosts (Remote-SSH,
  // dev containers, vscode.dev) where extensions live under *-server/.
  for (const root of [join(homedir(), ".vscode", "extensions"),
                       join(homedir(), ".vscode-server", "extensions"),
                       join(homedir(), ".vscode-server-insiders", "extensions"),
                       join(homedir(), ".cursor", "extensions"),
                       join(homedir(), ".cursor-server", "extensions")]) {
    try {
      const hits = globClaudeCode(root).sort();
      if (hits.length) return hits[hits.length - 1];
    } catch { /* ignore */ }
  }
  return null;
}

// Discover Claude Code's live JSONL transcript. CRITICAL: multiple Claude
// sessions can share a cwd (e.g. an interactive VS Code session AND a CLI/
// agent session). "Newest jsonl" alone tails whichever moved last — often the
// wrong one, so `done`/tool track a different session. We therefore prefer the
// newest transcript whose `entrypoint` is "claude-vscode" (the interactive VS
// Code instance whose webview we patch); fall back to newest-overall only if
// none are tagged (older CC builds). VIBE_ADS_CC_LOG overrides. "" => LogTail
// yields null => block self-simulates.
export function locateClaudeCodeLog(): string {
  const explicit = process.env.KICKBACKS_CC_LOG
    || process.env.VIBE_ADS_CC_LOG;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const root = join(homedir(), ".claude", "projects");
    if (!existsSync(root)) return "";
    const cands: { p: string; m: number }[] = [];
    for (const proj of readdirSync(root)) {
      let entries: string[];
      try { entries = readdirSync(join(root, proj)); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(root, proj, f);
        try { cands.push({ p, m: statSync(p).mtimeMs }); } catch { /* ignore */ }
      }
    }
    if (!cands.length) return "";
    cands.sort((a, b) => b.m - a.m);
    // NOTE: when multiple Claude Code sessions share a cwd they all live here,
    // all tagged "claude-vscode", with NO filesystem signal identifying which
    // belongs to this VS Code window. Newest-mtime is the best available proxy
    // and is correct for the normal one-session-per-workspace case; it's only
    // ambiguous when a second (e.g. agent/CLI) session runs in the same repo.
    return cands[0].p;
  } catch { return ""; }
}
