// Vibe-Ads CLI status line. Shipped raw (placeholders substituted at install).
// Pure: reads a cache file and prints once. No network, no stdin, never throws.
import { readFileSync } from "node:fs";

try {
  const CACHE = __VIBE_ADS_CLI_AD_PATH__;
  const FRESH_MS = __VIBE_ADS_FRESH_MS__;
  const o = JSON.parse(readFileSync(CACHE, "utf8"));
  const fresh = o && typeof o.ts === "number"
    && (Date.now() - o.ts) <= FRESH_MS
    && typeof o.adText === "string" && o.adText.length > 0;
  if (fresh) {
    const text = "ad· " + o.adText;
    const url = typeof o.clickUrl === "string" ? o.clickUrl : "";
    const ESC = "";
    // OSC 8 hyperlink: ESC ]8;; URL ESC \  TEXT  ESC ]8;; ESC \
    const out = url
      ? ESC + "]8;;" + url + ESC + "\\" + text + ESC + "]8;;" + ESC + "\\"
      : text;
    process.stdout.write(out);
  }
} catch { /* prime directive: never break the CLI */ }
process.exit(0);
