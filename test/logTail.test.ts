import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTail } from "../src/activity/logTail";

// Mirrors Claude Code's JSONL transcript: one JSON record per line; assistant
// lines carry message.content[] (tool_use blocks) + message.stop_reason.
function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
const asst = (blocks: object[], stop: string | null) => ({
  type: "assistant", timestamp: "2026-05-16T22:54:24.104Z",
  message: { role: "assistant", stop_reason: stop, content: blocks },
});
const tmp = () => join(mkdtempSync(join(tmpdir(), "vibe-ads-log-")), "s.jsonl");

describe("LogTail (JSONL)", () => {
  it("returns null when no log file (best-effort, never throws)", () => {
    expect(new LogTail("/no/such/file.jsonl").current()).toBeNull();
  });

  it("extracts the most-recent tool_use name + numeric ts", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      asst([{ type: "tool_use", name: "Read" }], "tool_use"),
      asst([{ type: "tool_use", name: "Bash" }], "tool_use"),
    ]), "utf8");
    const a = new LogTail(f).current();
    expect(a?.tool).toBe("Bash");
    expect(typeof a?.ts).toBe("number");
    expect(a?.done).toBe(false);          // stop_reason "tool_use" => not done
  });

  it("done=true when the latest assistant turn ended (stop_reason=end_turn)", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Grep" }], "tool_use"),
      asst([{ type: "text", text: "all set." }], "end_turn"),
    ]), "utf8");
    const a = new LogTail(f).current();
    expect(a?.done).toBe(true);
    expect(a?.tool).toBe("Grep");         // last tool still reported for context
  });

  it("malformed / non-JSON content yields null, never throws", () => {
    const f = tmp();
    writeFileSync(f, "\x00\x01 not json at all\n{ broken", "utf8");
    expect(new LogTail(f).current()).toBeNull();
  });

  it("skips a sliced first line and still parses the rest", () => {
    const f = tmp();
    writeFileSync(f, '{"partial":  \n' +
      JSON.stringify(asst([{ type: "tool_use", name: "Edit" }], "tool_use")) +
      "\n", "utf8");
    expect(new LogTail(f).current()?.tool).toBe("Edit");
  });

  it("activityAgeMs: null when no transcript (idle/unknown)", () => {
    expect(new LogTail("/no/such/file.jsonl").activityAgeMs()).toBeNull();
  });

  it("activityAgeMs: small age right after a transcript write (CC in use)", () => {
    const f = tmp();
    writeFileSync(f, "{}\n", "utf8");
    const age = new LogTail(f).activityAgeMs();
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThanOrEqual(0);
    expect(age as number).toBeLessThan(60_000);
  });
});
