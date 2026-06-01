import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { UpdateClient } from "../src/update/client";

// wave-2A-F01 introduces a 10 KiB minimum-size sanity for the VSIX bytes
// (rejects empty / garbage / CDN-stub downloads). Use a 12 KiB filler.
const bytes = Buffer.alloc(12 * 1024, 0x42); // 12288 bytes of "B"
const sha = createHash("sha256").update(bytes).digest("hex");

describe("UpdateClient", () => {
  it("installs when manifest version is newer and sha256 matches", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/ext/manifest"))
        return { ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
          url: "http://b/v1/ext/vibe-ads.vsix" }) } as Response;
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } as Response;
    });
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (buf) => { installed.push(Buffer.from(buf)); });
    expect(await c.checkOnce()).toBe(true);
    expect(installed).toHaveLength(1);
  });
  it("aborts on sha256 mismatch (no install)", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: "deadbeef",
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    expect(await c.checkOnce()).toBe(false);
    expect(installed).toHaveLength(0);
  });
  it("attempts a given version AT MOST ONCE (restart-loop guard)", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response));
    let mark: string | undefined;
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); },
      { attempted: (v) => v === mark, markAttempted: (v) => { mark = v; } });
    expect(await c.checkOnce()).toBe(true);   // first: installs, marks 0.2.0
    expect(installed).toHaveLength(1);
    expect(await c.checkOnce()).toBe(false);  // second: already attempted -> skip
    expect(installed).toHaveLength(1);        // NO re-install -> no restart loop
  });

  it("no-op when manifest version is not newer", async () => {
    const c = new UpdateClient("http://b", "0.2.0",
      (async () => ({ ok: true, json: async () =>
        ({ version: "0.2.0", sha256: "x", url: "y" }) })) as never,
      async () => { throw new Error("should not install"); });
    expect(await c.checkOnce()).toBe(false);
  });

  // wave-2A-F01 regression: VSIX size sanity + signature flag
  it("aborts when VSIX bytes are below the minimum-size sanity (10 KiB)", async () => {
    // 1 KiB filler — well under the 10 KiB floor. sha matches the manifest
    // so the sha-mismatch path can't be what blocks; only the size check.
    const tinyBytes = Buffer.alloc(1024, 0x55);
    const tinySha = createHash("sha256").update(tinyBytes).digest("hex");
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: tinySha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            tinyBytes.buffer.slice(tinyBytes.byteOffset,
                                   tinyBytes.byteOffset + tinyBytes.length) } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    expect(await c.checkOnce()).toBe(false);
    expect(installed).toHaveLength(0);
  });

  it("with VIBE_ADS_REQUIRE_MANIFEST_SIG=1 + no embedded pubkey -> abort", async () => {
    const original = process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = "1";
    try {
      const installed: Buffer[] = [];
      const f = vi.fn(async (url: string) =>
        url.endsWith("/manifest")
          ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
              url: "http://b/x.vsix" }) } as Response)
          : ({ ok: true, arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
            } as Response));
      const c = new UpdateClient("http://b", "0.1.0", f as never,
        async (b) => { installed.push(Buffer.from(b)); });
      // No __MANIFEST_PUBKEY_PEM__ define and the flag is on -> refuse.
      expect(await c.checkOnce()).toBe(false);
      expect(installed).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
      else process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = original;
    }
  });

  it("with flag OFF and no signature -> install proceeds (backward-compat)", async () => {
    const original = process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    delete process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    try {
      const installed: Buffer[] = [];
      const f = vi.fn(async (url: string) =>
        url.endsWith("/manifest")
          ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
              url: "http://b/x.vsix" }) } as Response)
          : ({ ok: true, arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
            } as Response));
      const c = new UpdateClient("http://b", "0.1.0", f as never,
        async (b) => { installed.push(Buffer.from(b)); });
      expect(await c.checkOnce()).toBe(true);
      expect(installed).toHaveLength(1);
    } finally {
      if (original !== undefined) process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = original;
    }
  });
});
