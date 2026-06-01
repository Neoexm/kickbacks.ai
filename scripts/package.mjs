import { spawnSync } from "node:child_process";
import { readFileSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Packages the extension into TWO files:
//   - kickbacks.vsix          — the canonical, STABLE artifact. The deploy
//     uploads this to the fixed GCS object gs://kickbacks-vsix/kickbacks.vsix,
//     so every running extension's self-update URL stays constant. Never
//     rename this one.
//   - kickbacks-<version>.vsix — a versioned copy with the version baked into
//     the file name, so a built artifact on disk is instantly identifiable.
// The version is the single source of truth in package.json (the deploy bumps
// it before packaging, so this picks up the new number automatically).

/** The versioned artifact name for a given semver. Pure; kept tiny but
 *  separate so the naming convention has one definition. */
export function versionedVsixName(version) {
  return `kickbacks-${version}.vsix`;
}

const STABLE = "kickbacks.vsix";

// scripts/package.mjs -> extension/
const extDir = join(fileURLToPath(import.meta.url), "..", "..");

function run() {
  const { version } = JSON.parse(
    readFileSync(join(extDir, "package.json"), "utf8"));
  const versioned = versionedVsixName(version);

  // Drop any stale versioned vsix from prior builds so the dir always holds
  // exactly the current one (plus the stable kickbacks.vsix). Best-effort.
  for (const f of readdirSync(extDir)) {
    if (/^kickbacks-.*\.vsix$/.test(f) && f !== versioned) {
      try { unlinkSync(join(extDir, f)); } catch { /* ignore */ }
    }
  }

  // shell:true so the vsce .cmd wrapper resolves on Windows (node_modules/.bin
  // is on PATH under `npm run`).
  const r = spawnSync("vsce",
    ["package", "--no-dependencies", "-o", STABLE],
    { cwd: extDir, stdio: "inherit", shell: true });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

  copyFileSync(join(extDir, STABLE), join(extDir, versioned));
  console.error(`packaged ${STABLE} + ${versioned} (v${version})`);
}

run();
