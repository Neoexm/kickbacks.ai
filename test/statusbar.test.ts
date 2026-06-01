import { describe, it, expect } from "vitest";
import { StatusBar } from "../src/statusbar";

// NOTE: VS Code codicons render as `$(name)` in status-bar text, so the raw
// string always contains `$(`. Earnings assertions match `$<digit>` instead.
describe("StatusBar", () => {
  it("renders each state; signed-in shows Kickbacks + earnings, no 'debug' word", () => {
    const sb = new StatusBar();

    sb.set({ kind: "signed-out" });
    expect(sb.text).toMatch(/sign in/i);

    sb.set({ kind: "active", version: "2.1.143", usd: "1.53" });
    expect(sb.text).toContain("Kickbacks");
    expect(sb.text).toMatch(/\$1\.53/);
    expect(sb.text).not.toMatch(/active|2\.1\.143/); // version is tooltip-only

    sb.set({ kind: "active", version: "2.1.143" }); // no figure yet => $0.00
    expect(sb.text).toContain("Kickbacks");
    expect(sb.text).toMatch(/\$0\.00 today · \$0\.00/);

    // debug renders exactly like active — never the word "debug"
    sb.set({ kind: "debug", on: true, usd: "2.00" });
    expect(sb.text).toMatch(/\$2\.00/);
    expect(sb.text).not.toMatch(/debug/i);

    sb.set({ kind: "incompatible", version: "9.9.9" });
    expect(sb.text).toMatch(/incompatible/i);
    expect(sb.text).toContain("9.9.9");

    sb.set({ kind: "killed" });
    expect(sb.text).toMatch(/killed/i);

    sb.set({ kind: "offline" });
    expect(sb.text).toMatch(/offline/i);

    sb.set({ kind: "ad", adText: "Try Acme Widgets — acme.com" });
    expect(sb.text).toBe("Try Acme Widgets — acme.com");
  });
});

describe("StatusBar S7 today+lifetime", () => {
  it("active renders today + lifetime", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143", usd: "1.20", usdToday: "0.04" });
    expect(sb.text).toMatch(/\$0\.04 today/);
    expect(sb.text).toMatch(/\$1\.20/);
    sb.dispose();
  });
  it("active with only lifetime defaults today to $0.00", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143", usd: "1.20" });
    expect(sb.text).toMatch(/\$0\.00 today · \$1\.20/);
    sb.dispose();
  });
  it("active with no earnings shows $0.00 (never a bare label)", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143" });
    expect(sb.text).toMatch(/\$0\.00 today · \$0\.00/);
    sb.dispose();
  });
  it("signed-out never shows $amount", () => {
    const sb = new StatusBar();
    sb.set({ kind: "signed-out" });
    expect(sb.text).not.toMatch(/\$\d/);
    sb.dispose();
  });
});
