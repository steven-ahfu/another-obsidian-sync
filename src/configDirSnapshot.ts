import type {
  ConfigDirSnapshotMetaRecord,
  ConfigDirSnapshotRecord,
} from "./localdb";
import type { Entity } from "./baseTypes";
import type { ObsConfigDirFileType } from "./obsFolderLister";

export interface ConfigDirSnapshotScope {
  configDir: string;
  syncConfigDir: boolean;
  syncTrash: boolean;
  syncBookmarks: boolean;
}

export const isConfigDirSnapshotMetaCompatible = (
  meta: ConfigDirSnapshotMetaRecord | undefined,
  scope: ConfigDirSnapshotScope
): boolean => {
  if (meta === undefined) return false;
  return (
    meta.configDir === scope.configDir &&
    meta.syncConfigDir === scope.syncConfigDir &&
    meta.syncTrash === scope.syncTrash &&
    meta.syncBookmarks === scope.syncBookmarks
  );
};

export const buildConfigDirSnapshotRecords = (
  localConfigDirContents: ObsConfigDirFileType[],
  shouldTrack: (key: string) => boolean,
  vaultRandomID: string
): ConfigDirSnapshotRecord[] => {
  const snapshot: ConfigDirSnapshotRecord[] = [];
  for (const entry of localConfigDirContents) {
    if (!shouldTrack(entry.key)) continue;
    snapshot.push({ key: entry.key, keyType: entry.type, vaultRandomID });
  }
  snapshot.sort((a, b) => a.key.localeCompare(b.key));
  return snapshot;
};

export const collectRecreatedConfigKeys = (
  snapshot: ConfigDirSnapshotRecord[],
  localConfigDirContents: ObsConfigDirFileType[]
): Set<string> => {
  const prevKeys = new Set(snapshot.map((e) => e.key));
  const recreated = new Set<string>();
  for (const entry of localConfigDirContents) {
    if (!prevKeys.has(entry.key)) recreated.add(entry.key);
  }
  return recreated;
};

/**
 * Returns synthetic Entity records for files that were in the snapshot but
 * are no longer local AND have no existing prevSync record — meaning they
 * were deleted locally since the last snapshot but prevSyncRecords doesn't
 * know about it (e.g. first sync after enabling syncConfigDir).
 */
export const synthesizeDeletedConfigDirEntities = (
  snapshot: ConfigDirSnapshotRecord[],
  localConfigDirContents: ObsConfigDirFileType[],
  prevSyncEntityList: Entity[],
  shouldTrack: (key: string) => boolean
): Entity[] => {
  const currentKeys = new Set(
    localConfigDirContents
      .filter((e) => shouldTrack(e.key))
      .map((e) => e.key)
  );
  const prevSyncKeys = new Set(prevSyncEntityList.map((e) => e.key));

  const synthesized: Entity[] = [];
  for (const entry of snapshot) {
    if (!shouldTrack(entry.key)) continue;
    // Still exists locally — not deleted
    if (currentKeys.has(entry.key)) continue;
    // Already tracked in prevSyncRecords — syncer handles it normally
    if (prevSyncKeys.has(entry.key)) continue;
    // Was in snapshot, gone locally, not in prevSync → synthesize as deleted
    synthesized.push({
      key: entry.key,
      keyRaw: entry.key,
      mtimeSvr: 0,
      mtimeCli: 0,
      size: 0,
      sizeRaw: 0,
    });
  }
  return synthesized;
};
