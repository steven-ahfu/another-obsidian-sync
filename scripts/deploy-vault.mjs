import "dotenv/config";
import fs from "fs";
import path from "path";

const PLUGIN_ID = "another-obsidian-sync";
const BUILD_DIR = "build";

// main.js comes from webpack's build/ output; manifest/styles stay at repo root.
const FILES = [
  { src: path.join(BUILD_DIR, "main.js"), dest: "main.js" },
  { src: "manifest.json", dest: "manifest.json" },
  { src: "styles.css", dest: "styles.css" },
];

// Normalize a path so the same .env value works from PowerShell and WSL.
// - On Windows, translate /mnt/<drive>/... → <DRIVE>:/...
// - On Linux,   translate <drive>:/... or <drive>:\... → /mnt/<drive>/...
function normalizeVaultPath(p) {
  if (process.platform === "win32") {
    const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
    if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
    return p;
  }
  const m = /^([a-z]):[\\/](.*)$/i.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  return p;
}

// Space-separated list of vault root paths in VAULT_PATHS (or single VAULT_PATH for compat)
const rawPaths = process.env.VAULT_PATHS || process.env.VAULT_PATH || "";
const vaultPaths = rawPaths
  .split(/\s*,\s*|\s+/)
  .filter(Boolean)
  .map(normalizeVaultPath);

if (vaultPaths.length === 0) {
  console.error("Error: VAULT_PATHS is not set in .env");
  process.exit(1);
}

for (const { src } of FILES) {
  if (!fs.existsSync(src)) {
    console.error(`Error: ${src} not found — run build first`);
    process.exit(1);
  }
}

for (const vaultPath of vaultPaths) {
  if (!fs.existsSync(vaultPath)) {
    console.error(`Error: vault path does not exist: ${vaultPath}`);
    console.error(`  (Check VAULT_PATHS in .env — original value resolves nowhere on this platform.)`);
    process.exit(1);
  }
  const obsidianDir = path.join(vaultPath, ".obsidian");
  if (!fs.existsSync(obsidianDir)) {
    console.error(`Error: ${vaultPath} is not an Obsidian vault (no .obsidian/ found)`);
    process.exit(1);
  }
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
    console.log(`Created: ${pluginDir}`);
  }
  for (const { src, dest } of FILES) {
    fs.copyFileSync(src, path.join(pluginDir, dest));
    console.log(`Copied ${src} → ${pluginDir}/${dest}`);
  }
}

console.log("Deploy complete.");
