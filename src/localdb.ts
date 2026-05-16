import localforage from "localforage";
export type LocalForage = typeof localforage;
import { nanoid } from "nanoid";
import { requireApiVersion, TAbstractFile, TFile, TFolder } from "obsidian";

import { API_VER_STAT_FOLDER, SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import type { Entity } from "./baseTypes";
import type { SyncPlanType } from "./syncV3";
import { statFix, toText, unixTimeToStr } from "./misc";

import { log } from "./moreOnLog";

export const DB_SCHEMA_VERSION = "20240601";

const DB_VERSION_NUMBER_IN_HISTORY = [20211114, 20220108, 20220326];
export const DEFAULT_DB_VERSION_NUMBER: number = 20220326;
export const DEFAULT_DB_NAME = "remotelysavedb";
export const DEFAULT_TBL_VERSION = "schemaversion";
export const DEFAULT_TBL_FILE_HISTORY = "filefolderoperationhistory";
export const DEFAULT_TBL_SYNC_MAPPING = "syncmetadatahistory";
export const DEFAULT_SYNC_PLANS_HISTORY = "syncplanshistory";
export const DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING = "vaultrandomidmapping";
export const DEFAULT_TBL_LOGGER_OUTPUT = "loggeroutput";
export const DEFAULT_TBL_CONFIG_DIR_SNAPSHOT = "configdirsnapshot";

export interface ConfigDirSnapshotRecord {
  key: string;
  keyType: "folder" | "file";
  vaultRandomID: string;
}

export interface ConfigDirSnapshotMetaRecord {
  configDir: string;
  syncConfigDir: boolean;
  syncTrash: boolean;
  syncBookmarks: boolean;
  capturedAt: number;
  vaultRandomID: string;
}

export interface FileFolderHistoryRecord {
  key: string;
  ctime: number;
  mtime: number;
  size: number;
  actionWhen: number;
  actionType: "delete" | "rename" | "renameDestination";
  keyType: "folder" | "file";
  renameTo: string;
  vaultRandomID: string;
}

interface SyncMetaMappingRecord {
  localKey: string;
  remoteKey: string;
  localSize: number;
  remoteSize: number;
  localMtime: number;
  remoteMtime: number;
  remoteExtraKey: string;
  remoteType: SUPPORTED_SERVICES_TYPE;
  keyType: "folder" | "file";
  vaultRandomID: string;
}

interface SyncPlanRecord {
  ts: number;
  remoteType: string;
  syncPlan: string;
  vaultRandomID: string;
}

export interface InternalDBs {
  versionTbl: LocalForage;
  fileHistoryTbl: LocalForage;
  syncMappingTbl: LocalForage;
  syncPlansTbl: LocalForage;
  vaultRandomIDMappingTbl: LocalForage;
  loggerOutputTbl: LocalForage;
  prevSyncRecordsTbl: LocalForage;
  fileContentHistoryTbl: LocalForage;
  configDirSnapshotTbl: LocalForage;
}

/**
 * This migration mainly aims to assign vault name or vault id into all tables.
 * @param db
 * @param vaultRandomID
 */
const migrateDBsFrom20211114To20220108 = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const oldVer = 20211114;
  const newVer = 20220108;

  const allPromisesToWait: Promise<any>[] = [];

  const keysInDeleteHistoryTbl = await db.fileHistoryTbl.keys();
  for (const key of keysInDeleteHistoryTbl) {
    if (key.startsWith(vaultRandomID)) {
      continue;
    }
    const value = (await db.fileHistoryTbl.getItem(
      key
    )) as FileFolderHistoryRecord;
    if (value === null || value === undefined) {
      continue;
    }
    if (value.vaultRandomID === undefined || value.vaultRandomID === "") {
      value.vaultRandomID = vaultRandomID;
    }
    const newKey = `${vaultRandomID}\t${key}`;
    allPromisesToWait.push(db.fileHistoryTbl.setItem(newKey, value));
    allPromisesToWait.push(db.fileHistoryTbl.removeItem(key));
  }

  const keysInSyncMappingTbl = await db.syncMappingTbl.keys();
  for (const key of keysInSyncMappingTbl) {
    if (key.startsWith(vaultRandomID)) {
      continue;
    }
    const value = (await db.syncMappingTbl.getItem(
      key
    )) as SyncMetaMappingRecord;
    if (value === null || value === undefined) {
      continue;
    }
    if (value.vaultRandomID === undefined || value.vaultRandomID === "") {
      value.vaultRandomID = vaultRandomID;
    }
    const newKey = `${vaultRandomID}\t${key}`;
    allPromisesToWait.push(db.syncMappingTbl.setItem(newKey, value));
    allPromisesToWait.push(db.syncMappingTbl.removeItem(key));
  }

  const keysInSyncPlansTbl = await db.syncPlansTbl.keys();
  for (const key of keysInSyncPlansTbl) {
    if (key.startsWith(vaultRandomID)) {
      continue;
    }
    const value = (await db.syncPlansTbl.getItem(key)) as SyncPlanRecord;
    if (value === null || value === undefined) {
      continue;
    }
    if (value.vaultRandomID === undefined || value.vaultRandomID === "") {
      value.vaultRandomID = vaultRandomID;
    }
    const newKey = `${vaultRandomID}\t${key}`;
    allPromisesToWait.push(db.syncPlansTbl.setItem(newKey, value));
    allPromisesToWait.push(db.syncPlansTbl.removeItem(key));
  }

  await Promise.all(allPromisesToWait);
  await db.versionTbl.setItem("version", newVer);
};

/**
 * no need to do anything except changing version
 * we just add more file operations in db, and no schema is changed.
 * @param db
 * @param vaultRandomID
 */
const migrateDBsFrom20220108To20220326 = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const oldVer = 20220108;
  const newVer = 20220326;
  await db.versionTbl.setItem("version", newVer);
};

const migrateDBs = async (
  db: InternalDBs,
  oldVer: number,
  newVer: number,
  vaultRandomID: string
) => {
  if (oldVer === newVer) {
    return;
  }
  if (oldVer === 20211114 && newVer === 20220108) {
    return await migrateDBsFrom20211114To20220108(db, vaultRandomID);
  }
  if (oldVer === 20220108 && newVer === 20220326) {
    return await migrateDBsFrom20220108To20220326(db, vaultRandomID);
  }
  if (oldVer === 20211114 && newVer === 20220326) {
    // TODO: more steps with more versions in the future
    await migrateDBsFrom20211114To20220108(db, vaultRandomID);
    await migrateDBsFrom20220108To20220326(db, vaultRandomID);
    return;
  }
  if (newVer < oldVer) {
    throw Error(
      "You've installed a new version, but then downgrade to an old version. Stop working!"
    );
  }
  // not implemented
  throw Error(`not supported internal db changes from ${oldVer} to ${newVer}`);
};

export const prepareDBs = async (
  vaultBasePath: string,
  vaultRandomIDFromOldConfigFile: string
) => {
  const db = {
    versionTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_VERSION,
    }),
    fileHistoryTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_FILE_HISTORY,
    }),
    syncMappingTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_SYNC_MAPPING,
    }),
    syncPlansTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_SYNC_PLANS_HISTORY,
    }),
    vaultRandomIDMappingTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING,
    }),
    loggerOutputTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_LOGGER_OUTPUT,
    }),
    prevSyncRecordsTbl: localforage.createInstance({
      name: "remotelysync",
      storeName: "prevSyncRecords",
    }),
    fileContentHistoryTbl: localforage.createInstance({
      name: "remotelysync",
      storeName: "fileContentHistory",
    }),
    configDirSnapshotTbl: localforage.createInstance({
      name: "remotelysync",
      storeName: "configDirSnapshot",
    }),
  } as InternalDBs;

  // try to get vaultRandomID firstly
  let vaultRandomID = "";
  const vaultRandomIDInDB: string | null =
    await db.vaultRandomIDMappingTbl.getItem(`path2id\t${vaultBasePath}`);
  if (vaultRandomIDInDB === null) {
    if (vaultRandomIDFromOldConfigFile !== "") {
      // reuse the old config id
      vaultRandomID = vaultRandomIDFromOldConfigFile;
    } else {
      // no old config id, we create a random one
      vaultRandomID = nanoid();
    }
    // save the id back
    await db.vaultRandomIDMappingTbl.setItem(
      `path2id\t${vaultBasePath}`,
      vaultRandomID
    );
    await db.vaultRandomIDMappingTbl.setItem(
      `id2path\t${vaultRandomID}`,
      vaultBasePath
    );
  } else {
    vaultRandomID = vaultRandomIDInDB;
  }

  if (vaultRandomID === "") {
    throw Error("no vaultRandomID found or generated");
  }

  const originalVersion: number | null = await db.versionTbl.getItem("version");
  if (originalVersion === null) {
    await db.versionTbl.setItem("version", DEFAULT_DB_VERSION_NUMBER);
  } else if (originalVersion === DEFAULT_DB_VERSION_NUMBER) {
    // do nothing
  } else {
    await migrateDBs(
      db,
      originalVersion,
      DEFAULT_DB_VERSION_NUMBER,
      vaultRandomID
    );
  }

  return {
    db: db,
    vaultRandomID: vaultRandomID,
  };
};

export const destroyDBs = async () => {
  const req = indexedDB.deleteDatabase(DEFAULT_DB_NAME);
  req.onerror = (event) => {
    log.error("tried to delete db but something goes wrong!");
    log.error(event);
  };
};

export const loadFileHistoryTableByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as FileFolderHistoryRecord[];
  await db.fileHistoryTbl.iterate((value, key, iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      records.push(value as FileFolderHistoryRecord);
    }
  });
  records.sort((a, b) => a.actionWhen - b.actionWhen); // ascending
  return records;
};

export const clearDeleteRenameHistoryOfKeyAndVault = async (
  db: InternalDBs,
  key: string,
  vaultRandomID: string
) => {
  const fullKey = `${vaultRandomID}\t${key}`;
  const item: FileFolderHistoryRecord | null = await db.fileHistoryTbl.getItem(
    fullKey
  );
  if (
    item !== null &&
    (item.actionType === "delete" || item.actionType === "rename")
  ) {
    await db.fileHistoryTbl.removeItem(fullKey);
  }
};

export const insertDeleteRecordByVault = async (
  db: InternalDBs,
  fileOrFolder: TAbstractFile,
  vaultRandomID: string
) => {
  let k: FileFolderHistoryRecord;
  if (fileOrFolder instanceof TFile) {
    k = {
      key: fileOrFolder.path,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: Date.now(),
      actionType: "delete",
      keyType: "file",
      renameTo: "",
      vaultRandomID: vaultRandomID,
    };
  } else if (fileOrFolder instanceof TFolder) {
    // key should endswith "/"
    const key = fileOrFolder.path.endsWith("/")
      ? fileOrFolder.path
      : `${fileOrFolder.path}/`;
    const ctime = 0; // they are deleted, so no way to get ctime, mtime
    const mtime = 0; // they are deleted, so no way to get ctime, mtime
    k = {
      key: key,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: Date.now(),
      actionType: "delete",
      keyType: "folder",
      renameTo: "",
      vaultRandomID: vaultRandomID,
    };
  }
  await db.fileHistoryTbl.setItem(`${vaultRandomID}\t${k.key}`, k);
};

/**
 * A file/folder is renamed from A to B
 * We insert two records:
 * A with actionType="rename"
 * B with actionType="renameDestination"
 * @param db
 * @param fileOrFolder
 * @param oldPath
 * @param vaultRandomID
 */
export const insertRenameRecordByVault = async (
  db: InternalDBs,
  fileOrFolder: TAbstractFile,
  oldPath: string,
  vaultRandomID: string
) => {
  let k1: FileFolderHistoryRecord;
  let k2: FileFolderHistoryRecord;
  const actionWhen = Date.now();
  if (fileOrFolder instanceof TFile) {
    k1 = {
      key: oldPath,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: actionWhen,
      actionType: "rename",
      keyType: "file",
      renameTo: fileOrFolder.path,
      vaultRandomID: vaultRandomID,
    };
    k2 = {
      key: fileOrFolder.path,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: actionWhen,
      actionType: "renameDestination",
      keyType: "file",
      renameTo: "", // itself is the destination, so no need to set this field
      vaultRandomID: vaultRandomID,
    };
  } else if (fileOrFolder instanceof TFolder) {
    const key = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
    const renameTo = fileOrFolder.path.endsWith("/")
      ? fileOrFolder.path
      : `${fileOrFolder.path}/`;
    let ctime = 0;
    let mtime = 0;
    if (requireApiVersion(API_VER_STAT_FOLDER)) {
      // TAbstractFile does not contain these info
      // but from API_VER_STAT_FOLDER we can manually stat them by path.
      const s = await statFix(fileOrFolder.vault, fileOrFolder.path);
      ctime = s.ctime;
      mtime = s.mtime;
    }
    k1 = {
      key: key,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: actionWhen,
      actionType: "rename",
      keyType: "folder",
      renameTo: renameTo,
      vaultRandomID: vaultRandomID,
    };
    k2 = {
      key: renameTo,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: actionWhen,
      actionType: "renameDestination",
      keyType: "folder",
      renameTo: "", // itself is the destination, so no need to set this field
      vaultRandomID: vaultRandomID,
    };
  }
  await Promise.all([
    db.fileHistoryTbl.setItem(`${vaultRandomID}\t${k1.key}`, k1),
    db.fileHistoryTbl.setItem(`${vaultRandomID}\t${k2.key}`, k2),
  ]);
};

export const upsertSyncMetaMappingDataByVault = async (
  serviceType: SUPPORTED_SERVICES_TYPE,
  db: InternalDBs,
  localKey: string,
  localMTime: number,
  localSize: number,
  remoteKey: string,
  remoteMTime: number,
  remoteSize: number,
  remoteExtraKey: string,
  vaultRandomID: string
) => {
  const aggregratedInfo: SyncMetaMappingRecord = {
    localKey: localKey,
    localMtime: localMTime,
    localSize: localSize,
    remoteKey: remoteKey,
    remoteMtime: remoteMTime,
    remoteSize: remoteSize,
    remoteExtraKey: remoteExtraKey,
    remoteType: serviceType,
    keyType: localKey.endsWith("/") ? "folder" : "file",
    vaultRandomID: vaultRandomID,
  };
  await db.syncMappingTbl.setItem(
    `${vaultRandomID}\t${remoteKey}`,
    aggregratedInfo
  );
};

export const getSyncMetaMappingByRemoteKeyAndVault = async (
  serviceType: SUPPORTED_SERVICES_TYPE,
  db: InternalDBs,
  remoteKey: string,
  remoteMTime: number,
  remoteExtraKey: string,
  vaultRandomID: string
) => {
  const potentialItem = (await db.syncMappingTbl.getItem(
    `${vaultRandomID}\t${remoteKey}`
  )) as SyncMetaMappingRecord;

  if (potentialItem === null) {
    // no result was found
    return undefined;
  }

  if (
    potentialItem.remoteKey === remoteKey &&
    potentialItem.remoteMtime === remoteMTime &&
    potentialItem.remoteExtraKey === remoteExtraKey &&
    potentialItem.remoteType === serviceType
  ) {
    // the result was found
    return potentialItem;
  } else {
    return undefined;
  }
};

export const clearAllSyncMetaMapping = async (db: InternalDBs) => {
  await db.syncMappingTbl.clear();
};

export const insertSyncPlanRecordByVault = async (
  db: InternalDBs,
  syncPlan: SyncPlanType | Record<string, any>,
  vaultRandomID: string,
  _remoteType?: string
) => {
  const ts = (syncPlan as any).ts ?? Date.now();
  const record = {
    ts: ts,
    tsFmt: (syncPlan as any).tsFmt,
    vaultRandomID: vaultRandomID,
    remoteType: (syncPlan as any).remoteType ?? _remoteType,
    syncPlan: JSON.stringify(syncPlan /* directly stringify */, null, 2),
  } as SyncPlanRecord;
  await db.syncPlansTbl.setItem(`${vaultRandomID}\t${ts}`, record);
};

export const clearAllSyncPlanRecords = async (db: InternalDBs) => {
  await db.syncPlansTbl.clear();
};

export const readAllSyncPlanRecordTextsByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as SyncPlanRecord[];
  await db.syncPlansTbl.iterate((value, key, iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      records.push(value as SyncPlanRecord);
    }
  });
  records.sort((a, b) => -(a.ts - b.ts)); // descending

  if (records === undefined) {
    return [] as string[];
  } else {
    return records.map((x) => x.syncPlan);
  }
};

/**
 * We remove records that are older than 7 days or 10000 records.
 * It's a heavy operation, so we shall not place it in the start up.
 * @param db
 */
export const clearExpiredSyncPlanRecords = async (db: InternalDBs) => {
  const MILLISECONDS_OLD = 1000 * 60 * 60 * 24 * 7; // 7 days
  const COUNT_TO_MANY = 10000;

  const currTs = Date.now();
  const expiredTs = currTs - MILLISECONDS_OLD;

  let records = (await db.syncPlansTbl.keys()).map((key) => {
    const ts = parseInt(key.split("\t")[1]);
    const expired = ts <= expiredTs;
    return {
      ts: ts,
      key: key,
      expired: expired,
    };
  });

  const keysToRemove = new Set(
    records.filter((x) => x.expired).map((x) => x.key)
  );

  if (records.length - keysToRemove.size > COUNT_TO_MANY) {
    // we need to find out records beyond 10000 records
    records = records.filter((x) => !x.expired); // shrink the array
    records.sort((a, b) => -(a.ts - b.ts)); // descending
    records.slice(COUNT_TO_MANY).forEach((element) => {
      keysToRemove.add(element.key);
    });
  }

  const ps = [] as Promise<void>[];
  keysToRemove.forEach((element) => {
    ps.push(db.syncPlansTbl.removeItem(element));
  });
  await Promise.all(ps);
};

export const readAllLogRecordTextsByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as { ts: number; r: string }[];
  await db.loggerOutputTbl.iterate((value, key, iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      const item = {
        ts: parseInt(key.split("\t")[1]),
        r: value as string,
      };
      records.push(item);
    }
  });

  // while reading the logs, we want it to be ascending
  records.sort((a, b) => a.ts - b.ts);

  if (records === undefined) {
    return [] as string[];
  } else {
    return records.map((x) => x.r);
  }
};

export const insertLoggerOutputByVault = async (
  db: InternalDBs,
  vaultRandomID: string,
  ...msg: any[]
) => {
  const ts = Date.now();
  const tsFmt = unixTimeToStr(ts);
  const key = `${vaultRandomID}\t${ts}`;

  try {
    const val = [`[${tsFmt}]`, ...msg.map((x) => toText(x))].join(" ");
    db.loggerOutputTbl.setItem(key, val);
  } catch (err) {
    // give up, and let it pass
  }
};

export const clearAllLoggerOutputRecords = async (db: InternalDBs) => {
  await db.loggerOutputTbl.clear();
};

/**
 * We remove records that are older than 7 days or 10000 records.
 * It's a heavy operation, so we shall not place it in the start up.
 * @param db
 */
export const clearExpiredLoggerOutputRecords = async (db: InternalDBs) => {
  const MILLISECONDS_OLD = 1000 * 60 * 60 * 24 * 7; // 7 days
  const COUNT_TO_MANY = 10000;

  const currTs = Date.now();
  const expiredTs = currTs - MILLISECONDS_OLD;

  let records = (await db.loggerOutputTbl.keys()).map((key) => {
    const ts = parseInt(key.split("\t")[1]);
    const expired = ts <= expiredTs;
    return {
      ts: ts,
      key: key,
      expired: expired,
    };
  });

  const keysToRemove = new Set(
    records.filter((x) => x.expired).map((x) => x.key)
  );

  if (records.length - keysToRemove.size > COUNT_TO_MANY) {
    // we need to find out records beyond 10000 records
    records = records.filter((x) => !x.expired); // shrink the array
    records.sort((a, b) => -(a.ts - b.ts)); // descending
    records.slice(COUNT_TO_MANY).forEach((element) => {
      keysToRemove.add(element.key);
    });
  }

  const ps = [] as Promise<void>[];
  keysToRemove.forEach((element) => {
    ps.push(db.loggerOutputTbl.removeItem(element));
  });
  await Promise.all(ps);
};

export const upsertPrevSyncRecordByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  prevSync: Entity
): Promise<void> => {
  const entityKey = prevSync.keyRaw ?? prevSync.key ?? "";
  const k = `${vaultRandomID}\t${profileID}\t${entityKey}`;
  await db.prevSyncRecordsTbl.setItem(k, prevSync);
};

export const getAllPrevSyncRecordsByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string
): Promise<Entity[]> => {
  const res: Entity[] = [];
  const prefix = `${vaultRandomID}\t${profileID}\t`;
  await db.prevSyncRecordsTbl.iterate((value: any, key: string) => {
    if (key.startsWith(prefix)) {
      if (value !== null && value !== undefined) {
        res.push(value as Entity);
      }
    }
  });
  return res;
};

export const clearPrevSyncRecordByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  key: string
): Promise<void> => {
  await db.prevSyncRecordsTbl.removeItem(
    `${vaultRandomID}\t${profileID}\t${key}`
  );
};

export const upsertFileContentHistoryByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  prevSync: Entity,
  prevContent: ArrayBuffer
): Promise<void> => {
  const entityKey = prevSync.keyRaw ?? prevSync.key ?? "";
  await db.fileContentHistoryTbl.setItem(
    `${vaultRandomID}\t${profileID}\t${entityKey}`,
    prevContent
  );
};

export const getFileContentHistoryByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  prevSync: Entity
): Promise<ArrayBuffer | null | undefined> => {
  const entityKey = prevSync.keyRaw ?? prevSync.key ?? "";
  return (await db.fileContentHistoryTbl.getItem(
    `${vaultRandomID}\t${profileID}\t${entityKey}`
  )) as ArrayBuffer | null | undefined;
};

export const clearFileContentHistoryByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  key: string
): Promise<void> => {
  await db.fileContentHistoryTbl.removeItem(
    `${vaultRandomID}\t${profileID}\t${key}`
  );
};

export const insertProfilerResultByVault = async (
  db: InternalDBs,
  result: string,
  vaultRandomID: string,
  remoteType: string
): Promise<void> => {
  const key = `${vaultRandomID}\t${remoteType}\t${Date.now()}`;
  await db.syncPlansTbl.setItem(key, result);
};

export const loadConfigDirSnapshotByVault = async (
  db: InternalDBs,
  vaultRandomID: string
): Promise<ConfigDirSnapshotRecord[]> => {
  const records: ConfigDirSnapshotRecord[] = [];
  await db.configDirSnapshotTbl.iterate((value, key) => {
    if (key.startsWith(`${vaultRandomID}\trecord\t`)) {
      records.push(value as ConfigDirSnapshotRecord);
    }
  });
  return records;
};

export const getConfigDirSnapshotMetaByVault = async (
  db: InternalDBs,
  vaultRandomID: string
): Promise<ConfigDirSnapshotMetaRecord | undefined> => {
  const item = await db.configDirSnapshotTbl.getItem<ConfigDirSnapshotMetaRecord>(
    `${vaultRandomID}\tmeta`
  );
  return item ?? undefined;
};

export const replaceConfigDirSnapshotByVault = async (
  db: InternalDBs,
  records: ConfigDirSnapshotRecord[],
  meta: ConfigDirSnapshotMetaRecord,
  vaultRandomID: string
): Promise<void> => {
  // Remove old records and meta
  const keysToDelete: string[] = [];
  await db.configDirSnapshotTbl.iterate((_value, key) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      keysToDelete.push(key);
    }
  });
  await Promise.all(keysToDelete.map((k) => db.configDirSnapshotTbl.removeItem(k)));

  // Write new
  await db.configDirSnapshotTbl.setItem(`${vaultRandomID}\tmeta`, meta);
  await Promise.all(
    records.map((r) =>
      db.configDirSnapshotTbl.setItem(`${vaultRandomID}\trecord\t${r.key}`, r)
    )
  );
};
