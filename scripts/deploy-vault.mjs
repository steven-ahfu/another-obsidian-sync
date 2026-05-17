import "dotenv/config";
import fs from "fs";
import path from "path";

const PLUGIN_ID = "another-obsidian-sync";
const FILES = ["main.js", "manifest.json", "styles.css"];

// Space-separated list of vault root paths in VAULT_PATHS (or single VAULT_PATH for compat)
const rawPaths = process.env.VAULT_PATHS || process.env.VAULT_PATH || "";
const vaultPaths = rawPaths.split(/\s*,\s*|\s+/).filter(Boolean);

if (vaultPaths.length === 0) {
  console.error("Error: VAULT_PATHS is not set in .env");
  process.exit(1);
}

for (const file of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`Error: ${file} not found — run build first`);
    process.exit(1);
  }
}

for (const vaultPath of vaultPaths) {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
    console.log(`Created: ${pluginDir}`);
  }
  for (const file of FILES) {
    fs.copyFileSync(file, path.join(pluginDir, file));
    console.log(`Copied ${file} → ${pluginDir}/`);
  }
}

console.log("Deploy complete.");
