import { existsSync, statSync, readSync, openSync, closeSync } from "node:fs";

export interface Activity {
  tool: string;
  elapsedMs: number;
  ts: number;
  /** True when the latest assistant turn has finished (stop_reason set and
   *  not "tool_use") — drives the in-slot completion freeze. */
  done: boolean;
}

/** Best-effort, read-only tail of Claude Code's live JSONL session transcript
 *  (`~/.claude/projects/<sanitized-cwd>/<session>.jsonl`). Each line is a JSON
 *  record; assistant lines carry `message.content[]` (with `tool_use` blocks),
 *  a `timestamp`, and `message.stop_reason`. Any error/miss yields null so the
 *  injected block self-simulates. NEVER throws. The format is version-fragile
 *  and deliberately non-load-bearing (spec §4.5) — the S5 matrix flags drift. */
const IDLE_STALE_MS = 90_000;

export class LogTail {
  private firstSeen = Date.now();
  private lastTool = "";
  constructor(private readonly path: string) {}

  /** Age in ms since Claude Code last wrote its session transcript, or null
   *  when there's no readable transcript. An INDEPENDENT activity signal: it
   *  reflects real CC usage (the user firing sessions), NOT our injected
   *  overlay. The desync watchdog uses it to tell "user is using CC but our
   *  ads aren't rendering" (heal) from "user is simply idle" (leave alone).
   *  Cheaper than current() (a single stat, no read). Never throws. */
  activityAgeMs(): number | null {
    try {
      if (!this.path || !existsSync(this.path)) return null;
      // Clamp: a just-written file's mtime can be a hair ahead of Date.now()
      // (fs timestamp precision / clock skew), which would otherwise yield a
      // nonsensical negative age.
      return Math.max(0, Date.now() - statSync(this.path).mtimeMs);
    } catch { return null; }
  }

  current(): Activity | null {
    try {
      if (!this.path || !existsSync(this.path)) return null;
      const st = statSync(this.path);
      const size = st.size;
      const staleMs = Date.now() - st.mtimeMs;
      const want = Math.min(size, 128 * 1024);
      if (want === 0) return null;
      const fd = openSync(this.path, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(want);
        readSync(fd, buf, 0, want, size - want);
        text = buf.toString("utf8");
      } finally { closeSync(fd); }

      // A *partial* (mid-file) read may slice the first line — drop it.
      // A full read (want === size, offset 0) has no partial line: keep all.
      const lines = text.split("\n");
      if (want < size) lines.shift();

      let tool = "";
      let done: boolean | null = null;   // null until we see an assistant line
      // Walk newest → oldest: first assistant line decides `done`; first
      // tool_use block is the current/most-recent tool.
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln) continue;
        let o: Record<string, unknown>;
        try { o = JSON.parse(ln); } catch { continue; }
        const msg = o.message as Record<string, unknown> | undefined;
        if (o.type === "assistant" && msg) {
          if (done === null) {
            const sr = msg.stop_reason as string | null | undefined;
            // Set + not "tool_use" => the turn ended (end_turn/stop_sequence).
            done = !!sr && sr !== "tool_use";
          }
          if (!tool && Array.isArray(msg.content)) {
            for (const b of msg.content as Array<Record<string, unknown>>) {
              if (b && b.type === "tool_use" && typeof b.name === "string") {
                tool = b.name; break;
              }
            }
          }
        }
        if (tool && done !== null) break;
      }

      if (!tool && done === null) return null;   // nothing usable in the tail
      if (tool && tool !== this.lastTool) {
        this.lastTool = tool; this.firstSeen = Date.now();
      }
      const isDone = done === true || staleMs > IDLE_STALE_MS;
      return { tool, elapsedMs: Date.now() - this.firstSeen,
               ts: Date.now(), done: isDone };
    } catch { return null; }
  }
}
