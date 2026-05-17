import {
  Modal,
  Notice,
  Plugin,
  Setting,
  setIcon,
  FileSystemAdapter,
  Platform, TAbstractFile, Vault, EventRef,
} from "obsidian";
import cloneDeep from "lodash/cloneDeep";
import type {
  Entity,
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_ONEDRIVE,
  COMMAND_CALLBACK_DROPBOX,
} from "./baseTypes";
import {
  insertDeleteRecordByVault,
  insertRenameRecordByVault,
  prepareDBs,
  InternalDBs,
  insertLoggerOutputByVault,
  clearExpiredLoggerOutputRecords,
  clearExpiredSyncPlanRecords,
} from "./localdb";
import { syncer, SyncStatusType } from "./syncV3";
import { getClient } from "./fsGetter";
import { FakeFsEncrypt } from "./fsEncrypt";
import { FakeFsLocal } from "./fsLocal";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceDropbox,
  FakeFsDropbox,
} from "./fsDropbox";
import {
  AccessCodeResponseSuccessfulType,
  DEFAULT_ONEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqOnedrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedrive,
  FakeFsOnedrive,
} from "./fsOnedrive";
import { DEFAULT_S3_CONFIG } from "./fsS3";
import { DEFAULT_WEBDAV_CONFIG } from "./fsWebdav";
import { DEFAULT_PROTONDRIVE_CONFIG } from "./fsProtondrive";
import { RemotelySaveSettingTab } from "./settings";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { ObsConfigDirFileType, listFilesInObsFolder } from "./obsFolderLister";
import { I18n } from "./i18n";
import type { LangType, LangTypeAndAuto, TransItemType } from "./i18n";

import {DeletionOnRemote, deserializeMetadataOnRemote, MetadataOnRemote} from "./metadataOnRemote";
import { SyncAlgoV2Modal } from "./syncAlgoV2Notice";
import { applyPresetRulesInplace } from "./presetRules";

import { applyLogWriterInplace, log } from "./moreOnLog";
import {
  exportVaultLoggerOutputToFiles,
  exportVaultSyncPlansToFiles,
} from "./debugMode";
import { SizesConflictModal } from "./syncSizesConflictNotice";
import {mkdirpInVault, getLastSynced} from "./misc";
import {
  isConfigDirSnapshotMetaCompatible,
  buildConfigDirSnapshotRecords,
  synthesizeDeletedConfigDirEntities,
  type ConfigDirSnapshotScope,
} from "./configDirSnapshot";
import {
  loadConfigDirSnapshotByVault,
  getConfigDirSnapshotMetaByVault,
  replaceConfigDirSnapshotByVault,
  type ConfigDirSnapshotRecord,
  type ConfigDirSnapshotMetaRecord,
} from "./localdb";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  s3: DEFAULT_S3_CONFIG,
  webdav: DEFAULT_WEBDAV_CONFIG,
  dropbox: DEFAULT_DROPBOX_CONFIG,
  onedrive: DEFAULT_ONEDRIVE_CONFIG,
  protondrive: DEFAULT_PROTONDRIVE_CONFIG,
  password: "",
  serviceType: "s3",
  debugEnabled: false,
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  syncOnRemoteChangesAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: false,
  concurrency: 5,
  syncConfigDir: false,
  syncUnderscoreItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  enableStatusBarInfo: undefined,
  showLastSyncedOnly: undefined,
  lastSynced: -1,
  trashLocal: false,
  syncTrash: false,
  syncBookmarks: true,
  ignorePaths: [".trash", ".obsidian", "^_"],
};

interface OAuth2Info {
  verifier?: string;
  helperModal?: Modal;
  authDiv?: HTMLElement;
  revokeDiv?: HTMLElement;
  revokeAuthSetting?: Setting;
}

const iconNameSyncWait = "rotate-ccw";
const iconNameSyncRunning = "refresh-ccw";
const iconNameStatusBar = "refresh-ccw-dot";
const iconNameLogs = "file-text";

export default class RemotelySavePlugin extends Plugin {
  settings: RemotelySavePluginSettings;
  db: InternalDBs;
  syncStatus: SyncStatusType;
  syncStatusText?: string;
  statusBarElement: HTMLSpanElement;
  oauth2Info: OAuth2Info;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  i18n: I18n;
  vaultRandomID: string;
  isManual: boolean;
  isAlreadyRunning: boolean;
  syncOnSaveEvent?: EventRef;
  vaultScannerIntervalId?: number;
  syncOnRemoteIntervalID?: number;
  statusBarIntervalID: number;
  statusBarObserver?: MutationObserver;
  settingTab?: import("./settings").RemotelySaveSettingTab;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    // Make sure two syncs can't run at the same time
    if (this.syncStatus !== "idle") {
      if (triggerSource === "manual") {
        if (this.settings.debugEnabled) {
          new Notice(this.i18n.t("syncrun_debug_alreadyrunning", {stage: this.syncStatus}));
        } else {
          new Notice("1/" + this.i18n.t("syncrun_alreadyrunning", {maxSteps: "2"}));
        }
        log.debug(this.manifest.name, " already running in stage: ", this.syncStatus);
      }
      return;
    }

    log.debug(`[main] syncRun: starting, trigger=${triggerSource}`);
    this.setSyncIcon(true, triggerSource);

    try {
      const remoteFs = getClient(
        this.settings,
        this.app.vault.getName(),
        async () => { await this.saveSettings(); }
      );
      log.debug(`[main] syncRun: remoteFs serviceType=${remoteFs.serviceType}`);

      const password = this.settings.password ?? "";
      const cipherMethod = this.settings.cipherMethod ?? "aes-256-gcm";
      log.debug(`[main] syncRun: encryption active=${password !== ""} cipherMethod=${cipherMethod}`);

      // Always wrap remote in FakeFsEncrypt — syncer() requires fsEncrypt.innerFs === fsRemote
      const encryptedRemoteFs = new FakeFsEncrypt(remoteFs, password, cipherMethod);

      const localFs = new FakeFsLocal({
        vault: this.app.vault,
        syncConfigDir: this.settings.syncConfigDir ?? false,
        syncBookmarks: this.settings.syncBookmarks ?? false,
        syncUnderscoreItems: this.settings.syncUnderscoreItems ?? false,
      });

      const localConfigDirContents = this.shouldTrackConfigDirSnapshot()
        ? await listFilesInObsFolder(
            this.app.vault,
            this.manifest.id,
            this.settings.syncTrash ?? false
          )
        : undefined;

      const synthesizedDeletions: Entity[] = localConfigDirContents
        ? await this.getSynthesizedConfigDirDeletions(localConfigDirContents)
        : [];

      const syncResult = await syncer(
        localFs,
        remoteFs,
        encryptedRemoteFs,
        undefined, // profiler
        this.db,
        triggerSource,
        "default", // profileID
        this.vaultRandomID,
        this.app.vault.configDir,
        this.settings,
        this.manifest.version,
        async () => { await this.saveSettings(); },
        (_: number, total: number, toModify: number) =>
          `Sync would modify ${toModify} of ${total} files, exceeding the safety threshold.`,
        (isSyncing: boolean) => {
          if (isSyncing) {
            this.updateSyncStatus("syncing");
          }
          // idle/icon handled after syncer() returns
        },
        undefined, // notifyFunc
        async (_src: SyncTriggerSourceType, error: Error) => {
          new Notice(`Sync aborted: ${error.message}`, 10000);
        },
        undefined, // ribboonFunc
        undefined, // statusBarFunc
        async (_src: SyncTriggerSourceType, i: number, total: number) => {
          this.updateSyncStatus("syncing");
          this.updateStatusBar({ i, total });
        },
        synthesizedDeletions
      );

      const { uploadCount = 0, downloadCount = 0, deleteCount = 0, everythingOk = true } = syncResult ?? {};
      this.setSyncIcon(false);
      if (!everythingOk) {
        new Notice(`Sync finished with errors — check debug log`, 8000);
        this.updateSyncStatus("idle");
      } else if (triggerSource !== "dry") {
        this.settings.lastSynced = Date.now();
        await this.saveSettings();
        const summary = `↑${uploadCount} ↓${downloadCount} ✕${deleteCount}`;
        this.syncStatusText = summary;
        this.updateSyncStatus("idle");
        new Notice(`Sync complete: ${summary}`);
        await this.saveConfigDirSnapshot(localConfigDirContents);
      } else {
        this.updateSyncStatus("idle");
      }
    } catch (e) {
      const msg = (e as any)?.message ?? String(e);
      const stack = (e as any)?.stack ?? "(no stack)";
      const cause = (e as any)?.cause ? `\nCause: ${(e as any).cause}` : "";
      log.error("[main] syncRun error:", msg);
      log.error("[main] syncRun stack:", stack + cause);
      new Notice(`Sync failed: ${msg}`);
      this.updateSyncStatus("idle");
      this.setSyncIcon(false);
    }
  }

  private async createTrashIfDoesNotExist() {
    if (this.settings.syncTrash) {
      // when syncing to a device which never trashed a file we will error if this folder does not exist
      await this.createTrashFolderIfDoesNotExist(this.app.vault);
    }
  }

  private shouldTrackConfigDirSnapshot(): boolean {
    return !!(
      this.settings.syncConfigDir ||
      this.settings.syncTrash ||
      this.settings.syncBookmarks
    );
  }

  private getConfigDirSnapshotScope(): ConfigDirSnapshotScope {
    return {
      configDir: this.app.vault.configDir,
      syncConfigDir: this.settings.syncConfigDir ?? false,
      syncTrash: this.settings.syncTrash ?? false,
      syncBookmarks: this.settings.syncBookmarks ?? false,
    };
  }

  private isTrackedConfigDirKey(key: string): boolean {
    const configDir = this.app.vault.configDir;
    if (key === configDir || key.startsWith(`${configDir}/`)) return true;
    if (this.settings.syncTrash && (key === ".trash" || key === ".trash/" || key.startsWith(".trash/"))) return true;
    return false;
  }

  private async getSynthesizedConfigDirDeletions(
    localConfigDirContents: ObsConfigDirFileType[]
  ): Promise<Entity[]> {
    if (!this.shouldTrackConfigDirSnapshot()) return [];

    const scope = this.getConfigDirSnapshotScope();
    const snapshotMeta = await getConfigDirSnapshotMetaByVault(this.db, this.vaultRandomID);

    if (!isConfigDirSnapshotMetaCompatible(snapshotMeta, scope)) return [];

    const snapshot = await loadConfigDirSnapshotByVault(this.db, this.vaultRandomID);
    if (snapshot.length === 0) return [];

    return synthesizeDeletedConfigDirEntities(
      snapshot,
      localConfigDirContents,
      [], // syncer will deduplicate against real prevSyncEntityList
      (key) => this.isTrackedConfigDirKey(key)
    );
  }

  private async saveConfigDirSnapshot(
    localConfigDirContents?: ObsConfigDirFileType[]
  ): Promise<void> {
    if (!this.shouldTrackConfigDirSnapshot()) return;

    const contents =
      localConfigDirContents ??
      (await listFilesInObsFolder(
        this.app.vault,
        this.manifest.id,
        this.settings.syncTrash ?? false
      ));

    const scope = this.getConfigDirSnapshotScope();
    const records = buildConfigDirSnapshotRecords(
      contents,
      (key) => this.isTrackedConfigDirKey(key),
      this.vaultRandomID
    );

    const meta: ConfigDirSnapshotMetaRecord = {
      ...scope,
      capturedAt: Date.now(),
      vaultRandomID: this.vaultRandomID,
    };

    await replaceConfigDirSnapshotByVault(this.db, records, meta, this.vaultRandomID);
  }

  private updateSyncStatus(status: SyncStatusType) {
    this.syncStatus = status;
    this.updateStatusBar();
  }

  private setSyncIcon(running: boolean, triggerSource?: "manual" | "auto" | "dry" | "autoOnceInit") {
    if (this.syncRibbon === undefined) {
      return;
    }

    if (running) {
      setIcon(this.syncRibbon, iconNameSyncRunning);

      this.syncRibbon.setAttribute(
        "aria-label",
        this.i18n.t("syncrun_syncingribbon", {
          pluginName: this.manifest.name,
          triggerSource: triggerSource,
        })
      );
    } else {
      setIcon(this.syncRibbon, iconNameSyncWait);
      
      this.syncRibbon.setAttribute("aria-label", this.manifest.name);
    }
  }

  private updateStatusBar(syncQueue?: {i: number, total: number}) {
    const enabled = this.statusBarElement !== undefined && 
      this.settings.enableStatusBarInfo === true;

    // Update status text
    if (this.syncStatus === "idle") {
      const lastSynced = getLastSynced(this.i18n, this.settings.lastSynced);
      if (!this.syncStatusText || !this.syncStatusText.startsWith("↑")) {
        this.syncStatusText = lastSynced.lastSyncMsg;
      }
      if (enabled) {
        this.statusBarElement.setAttribute("aria-label", lastSynced.lastSyncLabelMsg);
      }
    } 
    
    if (this.syncStatus === "preparing") {
      this.syncStatusText = this.i18n.t("syncrun_status_preparing");
    }

    if (this.syncStatus === "syncing") {
      if (syncQueue !== undefined) {
        this.syncStatusText = this.i18n.t("syncrun_status_progress", {
          current: syncQueue.i.toString(),
          total: syncQueue.total.toString()
        });  
      } else {
        this.syncStatusText = this.i18n.t("syncrun_status_syncing");
      }
    }

    if (enabled) {
      this.statusBarElement.setText(this.syncStatusText);
    }
  }

  async promptAgreement(): Promise<boolean> {
    return new Promise((resolve) => {
      new SyncAlgoV2Modal(this.app, this.i18n, (result) => resolve(result)).open();
    });
  }

  async onload() {
    this.oauth2Info = {
      verifier: "",
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    }; // init

    this.currSyncMsg = "";

    await this.loadSettings();
    await this.checkIfPresetRulesFollowed();

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    // Check if they have agreed to uploading metadata
    if (!this.settings.agreeToUploadExtraMetadata) {
      const agreed = await this.promptAgreement();

      if (agreed) {
        this.settings.agreeToUploadExtraMetadata = true;
        await this.saveSettings();
      } else {
        this.unload();
        return;
      }
    }

    if (this.settings.debugEnabled) {
      log.setLevel("debug");
    }

    await this.checkIfOauthExpires();

    // MUST before prepareDB()
    // And, it's also possible to be an empty string,
    // which means the vaultRandomID is read from db later!
    const vaultRandomIDFromOldConfigFile =
      await this.getVaultRandomIDFromOldConfigFile();

    // no need to await this
    this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(
        vaultBasePath,
        vaultRandomIDFromOldConfigFile
      );
    } catch (err) {
      new Notice(err.message, 10 * 1000);
      throw err;
    }

    // must AFTER preparing DB
    this.addOutputToDBIfSet();
    this.enableAutoClearOutputToDBHistIfSet();

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist();

    this.registerEvent(
      this.app.vault.on("delete", async (fileOrFolder) => {
        await insertDeleteRecordByVault(
          this.db,
          fileOrFolder,
          this.vaultRandomID
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (fileOrFolder, oldPath) => {
        await insertRenameRecordByVault(
          this.db,
          fileOrFolder,
          oldPath,
          this.vaultRandomID
        );
      })
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK,
      async (inputParams) => {
        new Notice(
          t("protocol_callbacknotsupported", {
            params: JSON.stringify(inputParams),
          })
        );
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_DROPBOX,
      async (inputParams) => {
        if (inputParams.code !== undefined) {
          if (this.oauth2Info.helperModal !== undefined) {
            this.oauth2Info.helperModal.contentEl.empty();

            t("protocol_dropbox_connecting")
              .split("\n")
              .forEach((val) => {
                this.oauth2Info.helperModal.contentEl.createEl("p", {
                  text: val,
                });
              });
          }

          let authRes = await sendAuthReqDropbox(
            this.settings.dropbox.clientID,
            this.oauth2Info.verifier,
            inputParams.code,
            (err: any) => { console.error("Dropbox auth error:", err); }
          );

          const self = this;
          await setConfigBySuccessfullAuthInplaceDropbox(
            this.settings.dropbox,
            authRes,
            () => self.saveSettings()
          );

          const client = new FakeFsDropbox(
            this.settings.dropbox,
            this.app.vault.getName(),
            () => self.saveSettings()
          );

          const username = await client.getUserDisplayName();
          this.settings.dropbox.username = username;
          await this.saveSettings();

          new Notice(
            t("protocol_dropbox_connect_succ", {
              username: username,
            })
          );

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "dropbox-auth-button-hide",
            this.settings.dropbox.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_dropbox_connect_succ_revoke", {
              username: this.settings.dropbox.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "dropbox-revoke-auth-button-hide",
            this.settings.dropbox.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_dropbox_connect_fail"));
          throw Error(
            t("protocol_dropbox_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_ONEDRIVE,
      async (inputParams) => {
        if (inputParams.code !== undefined) {
          if (this.oauth2Info.helperModal !== undefined) {
            this.oauth2Info.helperModal.contentEl.empty();

            t("protocol_onedrive_connecting")
              .split("\n")
              .forEach((val) => {
                this.oauth2Info.helperModal.contentEl.createEl("p", {
                  text: val,
                });
              });
          }

          let rsp = await sendAuthReqOnedrive(
            this.settings.onedrive.clientID,
            this.settings.onedrive.authority,
            inputParams.code,
            this.oauth2Info.verifier,
            (err: any) => { console.error("OneDrive auth error:", err); }
          );

          if ((rsp as any).error !== undefined) {
            throw Error(`${JSON.stringify(rsp)}`);
          }

          const self = this;
          await setConfigBySuccessfullAuthInplaceOnedrive(
            this.settings.onedrive,
            rsp as AccessCodeResponseSuccessfulType,
            () => self.saveSettings()
          );

          const onedriveClient = new FakeFsOnedrive(
            this.settings.onedrive,
            this.app.vault.getName(),
            () => self.saveSettings()
          );
          this.settings.onedrive.username = await onedriveClient.getUserDisplayName();
          await this.saveSettings();

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "onedrive-auth-button-hide",
            this.settings.onedrive.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_onedrive_connect_succ_revoke", {
              username: this.settings.onedrive.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "onedrive-revoke-auth-button-hide",
            this.settings.onedrive.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_onedrive_connect_fail"));
          throw Error(
            t("protocol_onedrive_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    this.addCommand({
      id: "start-sync",
      name: t("command_startsync"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("manual");
      },
    });

    this.addCommand({
      id: "start-sync-dry-run",
      name: t("command_drynrun"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("dry");
      },
    });

    this.addCommand({
      id: "export-sync-plans-json",
      name: t("command_exportsyncplans_json"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          "json"
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-table",
      name: t("command_exportsyncplans_table"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          "table"
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-logs-in-db",
      name: t("command_exportlogsindb"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultLoggerOutputToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID
        );
        new Notice(t("settings_logtodbexport_notice"));
      },
    });

    this.addCommand({
      id: "get-sync-status",
      name: t("command_syncstatus"),
      icon: iconNameStatusBar,
      callback: () => new Notice(this.syncStatusText)
    });
    
    this.settingTab = new RemotelySaveSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Show status bar show by default on desktop only
    if (this.settings.enableStatusBarInfo === undefined) {
      this.settings.enableStatusBarInfo = Platform.isMobile ? false : true;
    }

    // Hide all other elements in status bar by default on mobile only
    if (this.settings.showLastSyncedOnly === undefined) {
      this.settings.showLastSyncedOnly = Platform.isMobile ? true : false;
    }

    this.saveSettings();

    // this.registerDomEvent(document, "click", (evt: MouseEvent) => {
    //   log.info("click", evt);
    // });

    this.enableAutoSyncIfSet();
    this.enableInitSyncIfSet();

    this.toggleSyncOnRemote(true);
    this.toggleSyncOnSave(true);
    this.toggleStatusBar(true);
    this.toggleStatusText(true);
    this.toggleStatusBarObserver(true);

    this.updateSyncStatus("idle");
  }

  async onunload() {
    this.syncRibbon = undefined;
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = undefined;
    }

    // Disable Features
    this.toggleSyncOnSave(false);
    this.toggleSyncOnRemote(false);
    this.toggleStatusText(false);
    this.toggleStatusBar(false);
    this.toggleStatusBarObserver(false);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );
    if (this.settings.dropbox.clientID === "") {
      this.settings.dropbox.clientID = DEFAULT_SETTINGS.dropbox.clientID;
    }
    if (this.settings.dropbox.remoteBaseDir === undefined) {
      this.settings.dropbox.remoteBaseDir = "";
    }
    if (this.settings.onedrive.clientID === "") {
      this.settings.onedrive.clientID = DEFAULT_SETTINGS.onedrive.clientID;
    }
    if (this.settings.onedrive.authority === "") {
      this.settings.onedrive.authority = DEFAULT_SETTINGS.onedrive.authority;
    }
    if (this.settings.onedrive.remoteBaseDir === undefined) {
      this.settings.onedrive.remoteBaseDir = "";
    }
    if (this.settings.webdav.manualRecursive === undefined) {
      this.settings.webdav.manualRecursive = false;
    }
    if (this.settings.webdav.depth === undefined) {
      this.settings.webdav.depth = "auto_unknown";
    }
    if (this.settings.webdav.remoteBaseDir === undefined) {
      this.settings.webdav.remoteBaseDir = "";
    }
    if (this.settings.s3.partsConcurrency === undefined) {
      this.settings.s3.partsConcurrency = 20;
    }
    if (this.settings.s3.forcePathStyle === undefined) {
      this.settings.s3.forcePathStyle = false;
    }
    if (this.settings.s3.disableS3MetadataSync == undefined) {
      this.settings.s3.disableS3MetadataSync = false;
    }
  }

  async checkIfPresetRulesFollowed() {
    const res = applyPresetRulesInplace(this.settings);
    if (res.changed) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(normalConfigToMessy(this.settings));
  }

  async checkIfOauthExpires() {
    let needSave: boolean = false;
    const current = Date.now();

    // fullfill old version settings
    if (
      this.settings.dropbox.refreshToken !== "" &&
      this.settings.dropbox.credentialsShouldBeDeletedAtTime === undefined
    ) {
      // It has a refreshToken, but not expire time.
      // Likely to be a setting from old version.
      // we set it to a month.
      this.settings.dropbox.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }
    if (
      this.settings.onedrive.refreshToken !== "" &&
      this.settings.onedrive.credentialsShouldBeDeletedAtTime === undefined
    ) {
      this.settings.onedrive.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }

    // check expired or not
    let dropboxExpired = false;
    if (
      this.settings.dropbox.refreshToken !== "" &&
      current >= this.settings.dropbox.credentialsShouldBeDeletedAtTime
    ) {
      dropboxExpired = true;
      this.settings.dropbox = cloneDeep(DEFAULT_DROPBOX_CONFIG);
      needSave = true;
    }

    let onedriveExpired = false;
    if (
      this.settings.onedrive.refreshToken !== "" &&
      current >= this.settings.onedrive.credentialsShouldBeDeletedAtTime
    ) {
      onedriveExpired = true;
      this.settings.onedrive = cloneDeep(DEFAULT_ONEDRIVE_CONFIG);
      needSave = true;
    }

    // save back
    if (needSave) {
      await this.saveSettings();
    }

    // send notice
    if (dropboxExpired && onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox and OneDrive for a while, you need to re-auth them again.`,
        6000
      );
    } else if (dropboxExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox for a while, you need to re-auth it again.`,
        6000
      );
    } else if (onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth OneDrive for a while, you need to re-auth it again.`,
        6000
      );
    }
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = "";
    if (this.settings.vaultRandomID !== undefined) {
      // In old version, the vault id is saved in data.json
      // But we want to store it in localForage later
      if (this.settings.vaultRandomID !== "") {
        // a real string was assigned before
        vaultRandomID = this.settings.vaultRandomID;
      }
      delete this.settings.vaultRandomID;
      await this.saveSettings();
    }
    return vaultRandomID;
  }

  async trash(x: string) {
    if (this.settings.trashLocal) {
      await this.app.vault.adapter.trashLocal(x);
      return;
    } else {
      // Attempt using system trash, if it fails fallback to trashing into .trash folder
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x);
      }
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(
    vaultBasePath: string,
    vaultRandomIDFromOldConfigFile: string
  ) {
    const { db, vaultRandomID } = await prepareDBs(
      vaultBasePath,
      vaultRandomIDFromOldConfigFile
    );
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  // Needed to update text for get command
  toggleStatusText(enabled: boolean) {
    // Clears the current interval
    if (this.statusBarIntervalID !== undefined) {
      window.clearInterval(this.statusBarIntervalID);
      this.statusBarIntervalID = undefined;
    }

    // Set up interval
    if (enabled) {
      this.statusBarIntervalID = window.setInterval(async () => {
        if (this.syncStatus !== "syncing") {
          this.updateStatusBar();
        }
      }, 30_000);

      this.updateStatusBar();
    }
  }

  toggleStatusBar(enabled: boolean) {  
    this.statusBarElement?.remove();

    const statusBar = document.getElementsByClassName("status-bar")[0] as HTMLElement;

    // Remove any remotely sync classes
    statusBar.removeClass("remotely-sync-show-status-bar");
    statusBar.style.marginBottom = "0px";

    Array.from(statusBar.children).forEach((element) => {
      element.removeClass("remotely-sync-hidden");
    });

    if (enabled && this.settings.enableStatusBarInfo) {
      // Enable status bar on mobile
      if (Platform.isMobile) {
        statusBar.addClass("remotely-sync-show-status-bar");
        
        // Shifts up the status bar on phone to not cover the navmenu
        if (Platform.isPhone) {
          const navBar = document.getElementsByClassName("mobile-navbar")[0] as HTMLElement;
          const height = window.getComputedStyle(navBar).getPropertyValue('height');
          statusBar.style.marginBottom = height;
        }
      }

      // Hide every element if set
      if (this.settings.showLastSyncedOnly)  {
        Array.from(statusBar.children).forEach((element) => {
          (element as HTMLElement).addClass("remotely-sync-hidden");
        });
      }

      // Create remotely sync element
      this.statusBarElement = this.addStatusBarItem();
      this.statusBarElement.createEl("span");
      this.statusBarElement.setAttribute("data-tooltip-position", "top");    
      this.updateStatusBar(); 
    }
  }

  async toggleSyncOnRemote(enabled: boolean) {
    // Clears the current interval
    if (this.syncOnRemoteIntervalID !== undefined) {
      window.clearInterval(this.syncOnRemoteIntervalID);
      this.syncOnRemoteIntervalID = undefined;
    }

    if (enabled === false || this.settings.syncOnRemoteChangesAfterMilliseconds === -1) {
      return;
    }

    let checkingMetadata = false;

    const syncOnRemote = async () => {
      if (this.syncStatus !== "idle" || checkingMetadata) {
        return;
      }

      checkingMetadata = true;
      const metadataMtime = await this.getMetadataMtime();
      checkingMetadata = false;

      if (metadataMtime === undefined) {
        return false;
      }

      if (metadataMtime !== this.settings.lastSynced) {
        log.debug("Sync on Remote ran | Remote Metadata:", metadataMtime + ", Last Synced:", this.settings.lastSynced);
        this.syncRun("auto");
        return true;
      }
    };

    if (Platform.isMobileApp) {
      const onLoadResult = await syncOnRemote();
      new Notice(onLoadResult === true ? this.i18n.t("remote_changes_found") : this.i18n.t("remote_changes_synced"));
    }

    this.syncOnRemoteIntervalID = window.setInterval(syncOnRemote, this.settings.syncOnRemoteChangesAfterMilliseconds);
  }

  async toggleSyncOnSave(enabled: boolean) {
    let alreadyScheduled = false;

    // Unregister vault change event
    if (this.syncOnSaveEvent !== undefined) {
      this.app.vault.offref(this.syncOnSaveEvent);
      this.syncOnSaveEvent = undefined;
    }

    // Unregister scanning for .obsidian changes
    if (this.vaultScannerIntervalId !== undefined) {
      window.clearInterval(this.vaultScannerIntervalId);
      this.vaultScannerIntervalId = undefined;
    }

    if (enabled === false || this.settings.syncOnSaveAfterMilliseconds === -1) {
      return;
    }
    
    // Register vault change event
    this.syncOnSaveEvent = this.app.vault.on("modify", () => {
      if (this.syncStatus !== "idle" || alreadyScheduled) {
        return;
      }

      alreadyScheduled = true;
      log.debug(`Scheduled a sync run for ${this.settings.syncOnSaveAfterMilliseconds} milliseconds later`);

      setTimeout(async () => {
        log.debug("Sync on save ran");
        await this.syncRun("auto");  
        alreadyScheduled = false;
      }, this.settings.syncOnSaveAfterMilliseconds);
    });

    // Scan vault for config directory changes
    const scanVault = async () => {
      if (this.syncStatus !== "idle" || alreadyScheduled || !this.settings.syncConfigDir) {
        return;
      }

      log.debug("Scanning config directory for changes");

      let localConfigContents: ObsConfigDirFileType[] = await listFilesInObsFolder(this.app.vault, this.manifest.id, this.settings.syncTrash);

      for (let i = 0; i < localConfigContents.length; i++) {
        const file = localConfigContents[i];

        if (file.key.includes(".obsidian/plugins/another-obsidian-sync/")) {
          continue;
        }

        if (file.mtime > this.settings.lastSynced) {
          log.debug("Unsynced config file found: ", file.key)
          alreadyScheduled = true;
          log.debug(`Scheduled a sync run for ${this.settings.syncOnSaveAfterMilliseconds} milliseconds later`);

          setTimeout(async () => {
            log.debug("Sync on save ran");
            await this.syncRun("auto");  
            alreadyScheduled = false;
          }, this.settings.syncOnSaveAfterMilliseconds);

          break;
        }
      }
    }

    // Scans every 60 seconds
    this.vaultScannerIntervalId = window.setInterval(scanVault, 30_000);
  }

  toggleStatusBarObserver(enabled: boolean) {
    this.statusBarObserver?.disconnect();
    this.statusBarObserver = undefined;

    // Refresh status bar if new elements are found only if show only last synced is set.
    if (enabled && this.settings.showLastSyncedOnly) {
      this.statusBarObserver = new MutationObserver((mutationList, observer) => {
        let shouldCall = false;
        let byPlugin = false;

        for (const mutation of mutationList) {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            shouldCall = true;
          }

          mutation.addedNodes.forEach((node) => {
            if ((node as Element).className === "status-bar-item plugin-another-obsidian-sync") {
              byPlugin = true;
            }
          })
        }
      
        if (shouldCall && !byPlugin) {
          log.debug("Status bar item added, refreshing status bar.")
          this.toggleStatusBar(true);
        }
      });

      const statusBar = document.getElementsByClassName("status-bar")[0];
      this.statusBarObserver.observe(statusBar, { childList: true});
    }
  }
  
  async getMetadataMtime(): Promise<number | undefined> {
    try {
      const client = getClient(
        this.settings,
        this.app.vault.getName(),
        async () => { await this.saveSettings(); }
      );
      const entities = await client.walkPartial();
      const { DEFAULT_FILE_NAME_FOR_METADATAONREMOTE } = await import("./metadataOnRemote");
      const metaEntity = entities.find((e) => e.key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE);
      if (metaEntity === undefined) {
        return this.settings.lastSynced;
      }
      return metaEntity.mtimeSvr ?? metaEntity.mtimeCli;
    } catch (e) {
      log.debug("[main] getMetadataMtime error:", e);
      return this.settings.lastSynced;
    }
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          this.syncRun("auto");
        }, this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          this.syncRun("autoOnceInit");
        }, this.settings.initRunAfterMilliseconds);
      });
    }
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir = this.manifest.dir;
    const pluginConfigDirExists = await this.app.vault.adapter.exists(
      pluginConfigDir
    );
    if (!pluginConfigDirExists) {
      // what happened?
      return;
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);

    const contentText = "data.json\n";

    try {
      if (!ignoreFileExists) {
        // not exists, directly create
        // no need to await
        this.app.vault.adapter.write(ignoreFile, contentText);
      }
    } catch (error) {
      // just skip
    }
  }

  addOutputToDBIfSet() {
    if (this.settings.logToDB) {
      applyLogWriterInplace((...msg: any[]) => {
        insertLoggerOutputByVault(this.db, this.vaultRandomID, ...msg);
      });
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 45;
    const autoClearOutputToDBHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        if (this.settings.logToDB) {
          clearExpiredLoggerOutputRecords(this.db);
        }
      }, initClearOutputToDBHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        if (this.settings.logToDB) {
          clearExpiredLoggerOutputRecords(this.db);
        }
      }, autoClearOutputToDBHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45;
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, initClearSyncPlanHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, autoClearSyncPlanHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }

  private async createTrashFolderIfDoesNotExist(vault: Vault) {
    let trashStat = await vault.adapter.stat('.trash');
    if (trashStat == null) {
      await vault.adapter.mkdir('.trash');
    }
  }
}
