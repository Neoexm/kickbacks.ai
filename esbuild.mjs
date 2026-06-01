import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-root .env reader (mirrors scripts/deploy.mjs::readEnvFile so build &
// publish stay consistent). Trivial KEY=value parser; quotes / blanks /
// comments tolerated; missing file ⇒ all build flags fall back to safe
// defaults below. Pulling dotenv as a dep would be overkill here.
function readDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"'))
        || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const isTrue = (v) => v === "true" || v === "1" || v === "yes" || v === "on";

// extension/ sits one level below the repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = readDotenv(resolve(HERE, "..", ".env"));
const BUILD_FLAGS = {
  developer: isTrue(ROOT_ENV.KICKBACKS_DEVELOPER ?? "false"),
  adminUrl: ROOT_ENV.KICKBACKS_ADMIN_URL ?? "",
  siteUrl: ROOT_ENV.KICKBACKS_SITE_URL ?? "",
  verbose: isTrue(ROOT_ENV.KICKBACKS_VERBOSE ?? "false"),
  codex: isTrue(ROOT_ENV.KICKBACKS_CODEX ?? "false"),
  testHooks: isTrue(ROOT_ENV.KICKBACKS_TEST_HOOKS ?? "false"),
};

function copyAsset(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

// Stamp a build timestamp into package.json `description` so the running
// build is identifiable in the VS Code Extensions panel (ends the "did my
// reload pick up the new bundle?" guesswork). HARDENED: strips EVERY prior
// " · built <ts>" segment (greedy from the first occurrence to end) — the old
// trailing-only regex left duplicate "· built …Z · built …Z" suffixes when
// concurrent builds / reverts interleaved (observed in the wild). Targeted
// single-line edit; formatting preserved.
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// Captured from package.json `version` below and baked into the bundle so the
// running extension can compare its own semver against the deploy sentinel.
let pkgVersion = "0.0.0";
// Re-assert marketplace metadata on EVERY build. The repo is worked by a
// parallel agent fleet that periodically reverts/reformats package.json
// (see project memory); without this, author/license/links silently vanish
// from shipped VSIXs. JSON round-trip keeps it format-stable & idempotent.
{
  const pj = JSON.parse(readFileSync("package.json", "utf8"));
  pkgVersion = String(pj.version || "0.0.0");
  pj.author ??= { name: "Andrew McCalip", url: "https://github.com/andrewmccalip" };
  pj.license ??= "SEE LICENSE IN LICENSE";
  pj.homepage ??= "https://kickbacks.ai";
  pj.bugs ??= { url: "https://github.com/andrewmccalip/kickbacks/issues" };
  const c = pj.contributes?.commands;
  if (c && !c.some((x) => x.command === "kickbacks.signOut")) {
    const i = c.findIndex((x) => x.command === "kickbacks.signIn");
    if (i >= 0) c.splice(i + 1, 0,
      { command: "kickbacks.signOut", title: "Kickbacks: Sign out" });
  }
  pj.description = "Get paid while you code. Subtle, clickable ads in the Claude Code and Codex spinners — 50/50 revenue split to users.";
  writeFileSync("package.json", JSON.stringify(pj, null, 2) + "\n");
}
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], outfile: "dist/extension.js", target: "node18",
  // Bake the build epoch into the bundle so the extension can show a LIVE
  // "built Nh ago" at runtime (the VS Code Installation panel is not author-
  // extensible — this is the only place a truthful relative age can live).
  define: { __BUILD_TS__: JSON.stringify(stamp),
            __BUILD_VERSION__: JSON.stringify(pkgVersion),
            // Build-time flags from the repo-root .env. Runtime sentinels /
            // process.env still take precedence at call time (see log.ts +
            // buildflags.ts) — these change the SHIPPED default only.
            __DEVELOPER_MODE__: JSON.stringify(BUILD_FLAGS.developer),
            __ADMIN_URL__: JSON.stringify(BUILD_FLAGS.adminUrl),
            __SITE_URL__: JSON.stringify(BUILD_FLAGS.siteUrl),
            __BUILD_VERBOSE__: JSON.stringify(BUILD_FLAGS.verbose),
            __BUILD_CODEX_OPTIN__: JSON.stringify(BUILD_FLAGS.codex),
            __BUILD_TEST_HOOKS_OPTIN__: JSON.stringify(BUILD_FLAGS.testHooks) },
});
// The injected block is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/claude-code/block.asset.js",
          "dist/adapters/claude-code/block.asset.js");
// The CLI status-line script is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/claude-cli/statusline.asset.mjs",
          "dist/adapters/claude-cli/statusline.asset.mjs");
// The Codex thinking-shimmer injection is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/codex/block.asset.js",
          "dist/adapters/codex/block.asset.js");
// Codex CLI wrapper templates (Windows .cmd + POSIX shell). Shipped raw.
copyAsset("src/adapters/codex-cli/wrapper.cmd.asset",
          "dist/adapters/codex-cli/wrapper.cmd.asset");
copyAsset("src/adapters/codex-cli/wrapper.sh.asset",
          "dist/adapters/codex-cli/wrapper.sh.asset");
// Ship the DETAILS-pane readme as README.md (the source file is .vscodeignore'd
// and vsce only renders README.md) with the absolute build time stamped in, so
// the marketplace DETAILS body always reflects the shipped build.
try {
  const rd = readFileSync("readme_extension.md", "utf8")
    .replace(/<!-- BUILD -->.*$/m, "")
    .replace(/(<\/h1>)/i, `$1\n\n<!-- BUILD --> <p align="center"><sub>build ${stamp}</sub></p>`);
  writeFileSync("README.md", rd);
} catch { /* readme is best-effort; never fail the build */ }
console.log(`built dist/extension.js + CC & Codex block assets + README.md (build ${stamp})`);
console.log(`  build flags: developer=${BUILD_FLAGS.developer}`
  + ` verbose=${BUILD_FLAGS.verbose} codex=${BUILD_FLAGS.codex}`
  + ` testHooks=${BUILD_FLAGS.testHooks}`
  + (BUILD_FLAGS.developer
      ? `  admin=${BUILD_FLAGS.adminUrl || "<unset>"} site=${BUILD_FLAGS.siteUrl || "<unset>"}`
      : ""));
