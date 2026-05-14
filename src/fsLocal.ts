import type { TFile, TFolder, Vault } from "obsidian";
import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";
import { log } from "./moreOnLog";
import { mkdirpInVault } from "./misc";

export interface FakeFsLocalConfig {
  vault: Vault;
  syncConfigDir: boolean;
  syncBookmarks: boolean;
  syncUnderscoreItems: boolean;
}

export class FakeFsLocal extends FakeFs {
  readonly serviceType = "s3" as const; // local fs has no remote service type

  private vault: Vault;
  private syncConfigDir: boolean;
  private syncBookmarks: boolean;
  private syncUnderscoreItems: boolean;

  constructor(cfg: FakeFsLocalConfig) {
    super();
    this.vault = cfg.vault;
    this.syncConfigDir = cfg.syncConfigDir;
    this.syncBookmarks = cfg.syncBookmarks;
    this.syncUnderscoreItems = cfg.syncUnderscoreItems;
  }

  async walk(): Promise<Entity[]> {
    const files = this.vault.getAllLoadedFiles();
    const result: Entity[] = [];

    for (const f of files) {
      if (this._shouldSkip(f.path)) continue;

      if ((f as TFolder).children !== undefined) {
        result.push({
          key: f.path + "/",
          keyRaw: f.path + "/",
          size: 0,
          synthesizedFolder: true,
        });
      } else {
        const tf = f as TFile;
        const stat = await this.vault.adapter.stat(tf.path);
        result.push({
          key: tf.path,
          keyRaw: tf.path,
          mtimeCli: stat?.mtime,
          ctimeCli: stat?.ctime,
          size: tf.stat.size,
        });
      }
    }

    log.debug(`[fsLocal] walk: found ${result.length} entities`);
    return result;
  }

  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const isFolder = key.endsWith("/");
    if (isFolder) {
      return { key, keyRaw: key, size: 0, synthesizedFolder: true };
    }
    const stat = await this.vault.adapter.stat(key);
    if (stat === null) throw new Error(`File not found: ${key}`);
    return {
      key,
      keyRaw: key,
      mtimeCli: stat.mtime,
      ctimeCli: stat.ctime,
      size: stat.size,
    };
  }

  async mkdir(key: string): Promise<Entity> {
    const folderPath = key.endsWith("/") ? key.slice(0, -1) : key;
    await mkdirpInVault(folderPath + "/", this.vault);
    return { key, keyRaw: key, size: 0, synthesizedFolder: true };
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    _ctime: number
  ): Promise<Entity> {
    log.debug(`[fsLocal] writeFile: key=${key} size=${content.byteLength}`);
    await mkdirpInVault(key, this.vault);
    await this.vault.adapter.writeBinary(key, content, { mtime });
    const stat = await this.vault.adapter.stat(key);
    return {
      key,
      keyRaw: key,
      mtimeCli: stat?.mtime,
      ctimeCli: stat?.ctime,
      size: stat?.size ?? content.byteLength,
    };
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    log.debug(`[fsLocal] readFile: key=${key}`);
    return await this.vault.adapter.readBinary(key);
  }

  async rename(key1: string, key2: string, _mtime: number, _ctime: number): Promise<void> {
    log.debug(`[fsLocal] rename: ${key1} -> ${key2}`);
    await this.vault.adapter.rename(key1, key2);
  }

  async rm(key: string): Promise<void> {
    log.debug(`[fsLocal] rm: key=${key}`);
    const isFolder = key.endsWith("/");
    const path = isFolder ? key.slice(0, -1) : key;
    const af = this.vault.getAbstractFileByPath(path);
    if (af === null) return;
    await this.vault.trash(af, true);
  }

  private _shouldSkip(path: string): boolean {
    if (path === "/") return true;
    if (!this.syncUnderscoreItems && path.startsWith("_")) return true;
    if (!this.syncConfigDir && path.startsWith(".obsidian")) return true;
    return false;
  }
}
