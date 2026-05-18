import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  Platform,
  requireApiVersion,
  setIcon,
} from "obsidian";
import type { TextComponent } from "obsidian";
import {
  API_VER_REQURL,
  DEFAULT_DEBUG_FOLDER,
  SUPPORTED_SERVICES_TYPE,
  SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR,
  VALID_REQURL,
  WebdavAuthType,
  WebdavDepthType,
} from "./baseTypes";
import {
  exportVaultSyncPlansToFiles,
  exportVaultLoggerOutputToFiles,
} from "./debugMode";
import { exportSettingsToJSON, importSettingsFromJSON } from "./importExport";
import {
  clearAllSyncMetaMapping,
  clearAllSyncPlanRecords,
  destroyDBs,
  clearAllLoggerOutputRecords,
  insertLoggerOutputByVault,
  clearExpiredLoggerOutputRecords,
} from "./localdb";
import type RemotelySavePlugin from "./main"; // unavoidable
import { getClient } from "./fsGetter";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace,
  FakeFsDropbox,
} from "./fsDropbox";
import {
  DEFAULT_ONEDRIVE_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierOnedrive,
  AccessCodeResponseSuccessfulType as OnedriveAccessCodeResponseSuccessfulType,
  FakeFsOnedrive,
} from "./fsOnedrive";
import { DEFAULT_S3_CONFIG, FakeFsS3 } from "./fsS3";
import { FakeFsEncrypt } from "./fsEncrypt";
import { DEFAULT_WEBDAV_CONFIG, FakeFsWebdav } from "./fsWebdav";
import { messyConfigToNormal } from "./configPersist";
import type { TransItemType } from "./i18n";
import { checkHasSpecialCharForDir } from "./misc";
import { applyWebdavPresetRulesInplace } from "./presetRules";

import {
  applyLogWriterInplace,
  log,
  restoreLogWritterInplace,
} from "./moreOnLog";
import {encryptStringToBase64url} from "./encrypt";
import {DEFAULT_FILE_NAME_FOR_METADATAONREMOTE, DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2} from "./metadataOnRemote";

class PasswordModal extends Modal {
  plugin: RemotelySavePlugin;
  newPassword: string;

  constructor(app: App, plugin: RemotelySavePlugin, newPassword: string) {
    super(app);
    this.plugin = plugin;
    this.newPassword = newPassword;
  }

  onOpen() {
    let { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_password_title") });
    t("modal_password_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    [
      t("modal_password_attn1"),
      t("modal_password_attn2"),
      t("modal_password_attn3"),
      t("modal_password_attn4"),
      t("modal_password_attn5"),
    ].forEach((val, idx) => {
      if (idx < 3) {
        contentEl.createEl("p", {
          text: val,
          cls: "password-disclaimer",
        });
      } else {
        contentEl.createEl("p", {
          text: val,
        });
      }
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("modal_password_secondconfirm"));
        button.onClick(async () => {
          this.plugin.settings.password = this.newPassword;
          await this.plugin.saveSettings();
          new Notice(t("modal_password_notice"));
          this.close();
        });
        button.setClass("password-second-confirm");
      })
      .addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class ChangeRemoteBaseDirModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly newRemoteBaseDir: string;
  readonly service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newRemoteBaseDir: string,
    service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR
  ) {
    super(app);
    this.plugin = plugin;
    this.newRemoteBaseDir = newRemoteBaseDir;
    this.service = service;
  }

  onOpen() {
    let { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("h2", { text: t("modal_remotebasedir_title") });
    t("modal_remotebasedir_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    if (
      this.newRemoteBaseDir === "" ||
      this.newRemoteBaseDir === this.app.vault.getName()
    ) {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(
            t("modal_remotebasedir_secondconfirm_vaultname")
          );
          button.onClick(async () => {
            // in the settings, the value is reset to the special case ""
            this.plugin.settings[this.service].remoteBaseDir = "";
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    } else if (checkHasSpecialCharForDir(this.newRemoteBaseDir)) {
      contentEl.createEl("p", {
        text: t("modal_remotebasedir_invaliddirhint"),
      });
      new Setting(contentEl).addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
    } else {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t("modal_remotebasedir_secondconfirm_change"));
          button.onClick(async () => {
            this.plugin.settings[this.service].remoteBaseDir =
              this.newRemoteBaseDir;
            this.plugin.settings.lastSynced = -1;
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    }
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class DropboxAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
  }

  async onOpen() {
    let { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    let needManualPatse = false;
    const userAgent = window.navigator.userAgent.toLocaleLowerCase() || "";
    // some users report that,
    // the Linux would open another instance Obsidian if jumping back,
    // so fallback to manual paste on Linux
    if (
      Platform.isDesktopApp &&
      !Platform.isMacOS &&
      (/linux/.test(userAgent) ||
        /ubuntu/.test(userAgent) ||
        /debian/.test(userAgent) ||
        /fedora/.test(userAgent) ||
        /centos/.test(userAgent))
    ) {
      needManualPatse = true;
    }

    const { authUrl, verifier } = await getAuthUrlAndVerifierDropbox(
      this.plugin.settings.dropbox.clientID,
      needManualPatse
    );

    if (needManualPatse) {
      t("modal_dropboxauth_manualsteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: val,
          });
        });
    } else {
      this.plugin.oauth2Info.verifier = verifier;

      t("modal_dropboxauth_autosteps")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: val,
          });
        });
    }

    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_dropboxauth_copybutton"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_dropboxauth_copynotice"));
        };
      }
    );

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });

    if (needManualPatse) {
      let authCode = "";
      new Setting(contentEl)
        .setName(t("modal_dropboxauth_maualinput"))
        .setDesc(t("modal_dropboxauth_maualinput_desc"))
        .addText((text) =>
          text
            .setPlaceholder("")
            .setValue("")
            .onChange((val) => {
              authCode = val.trim();
            })
        )
        .addButton(async (button) => {
          button.setButtonText(t("submit"));
          button.onClick(async () => {
            new Notice(t("modal_dropboxauth_maualinput_notice"));
            try {
              const authRes = await sendAuthReqDropbox(
                this.plugin.settings.dropbox.clientID,
                verifier,
                authCode,
                (err: any) => { console.error("Dropbox auth error:", err); }
              );
              const self = this;
              setConfigBySuccessfullAuthInplace(
                this.plugin.settings.dropbox,
                authRes,
                () => self.plugin.saveSettings()
              );
              const client = new FakeFsDropbox(
                this.plugin.settings.dropbox,
                this.app.vault.getName(),
                () => self.plugin.saveSettings()
              );
              const username = await client.getUserDisplayName();
              this.plugin.settings.dropbox.username = username;
              await this.plugin.saveSettings();
              new Notice(
                t("modal_dropboxauth_maualinput_conn_succ", {
                  username: username,
                })
              );
              this.authDiv.toggleClass(
                "dropbox-auth-button-hide",
                this.plugin.settings.dropbox.username !== ""
              );
              this.revokeAuthDiv.toggleClass(
                "dropbox-revoke-auth-button-hide",
                this.plugin.settings.dropbox.username === ""
              );
              this.revokeAuthSetting.setDesc(
                t("modal_dropboxauth_maualinput_conn_succ_revoke", {
                  username: this.plugin.settings.dropbox.username,
                })
              );
              this.close();
            } catch (err) {
              console.error(err);
              new Notice(t("modal_dropboxauth_maualinput_conn_fail"));
            }
          });
        });
    }
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
  }

  async onOpen() {
    let { contentEl } = this;

    const { authUrl, verifier } = await getAuthUrlAndVerifierOnedrive(
      this.plugin.settings.onedrive.clientID,
      this.plugin.settings.onedrive.authority
    );
    this.plugin.oauth2Info.verifier = verifier;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    t("modal_onedriveauth_shortdesc")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });
    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_onedriveauth_copybutton"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_onedriveauth_copynotice"));
        };
      }
    );

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveRevokeAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
  }

  async onOpen() {
    let { contentEl } = this;
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step1"),
    });
    const consentUrl = "https://microsoft.com/consent";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step2"),
    });

    new Setting(contentEl)
      .setName(t("modal_onedriverevokeauth_clean"))
      .setDesc(t("modal_onedriverevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_onedriverevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.onedrive = JSON.parse(
              JSON.stringify(DEFAULT_ONEDRIVE_CONFIG)
            );
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "onedrive-auth-button-hide",
              this.plugin.settings.onedrive.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "onedrive-revoke-auth-button-hide",
              this.plugin.settings.onedrive.username === ""
            );
            new Notice(t("modal_onedriverevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_onedriverevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class SyncConfigDirModal extends Modal {
  plugin: RemotelySavePlugin;
  saveDropdownFunc: () => void;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    saveDropdownFunc: () => void
  ) {
    super(app);
    this.plugin = plugin;
    this.saveDropdownFunc = saveDropdownFunc;
  }

  async onOpen() {
    let { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    t("modal_syncconfig_attn")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("modal_syncconfig_secondconfirm"));
        button.onClick(async () => {
          this.plugin.settings.syncConfigDir = true;
          await this.plugin.saveSettings();
          this.saveDropdownFunc();
          new Notice(t("modal_syncconfig_notice"));
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class ExportSettingsModal extends Modal {
  plugin: RemotelySavePlugin;
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    const t = (x: TransItemType, vars?: any) => this.plugin.i18n.t(x, vars);

    contentEl.createEl("h2", { text: t("settings_export") });

    const hasOAuth = !!(
      this.plugin.settings.dropbox?.accessToken ||
      this.plugin.settings.onedrive?.accessToken
    );
    if (hasOAuth) {
      contentEl.createEl("p", {
        text: t("modal_export_oauth_warning"),
        cls: "password-disclaimer",
      });
    }

    contentEl.createEl("p", { text: t("modal_export_password_desc") });

    let password = "";
    new Setting(contentEl)
      .setName(t("modal_export_password_label"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text.setPlaceholder(t("modal_export_password_placeholder")).onChange((v) => {
          password = v;
        });
      });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText(t("modal_export_button")).setCta().onClick(async () => {
        try {
          const json = await exportSettingsToJSON(this.plugin.settings, password);
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `another-obsidian-sync-settings.json`;
          a.click();
          URL.revokeObjectURL(url);
          new Notice(t("modal_export_success"));
          this.close();
        } catch (e) {
          new Notice(t("modal_export_error"));
        }
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImportSettingsModal extends Modal {
  plugin: RemotelySavePlugin;
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    const t = (x: TransItemType, vars?: any) => this.plugin.i18n.t(x, vars);

    contentEl.createEl("h2", { text: t("settings_import") });
    contentEl.createEl("p", { text: t("modal_import_desc") });

    let fileContent = "";
    let password = "";

    const fileInput = contentEl.createEl("input", { type: "file" });
    fileInput.accept = ".json";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => { fileContent = e.target?.result as string ?? ""; };
      reader.readAsText(file);
    });

    const passwordSetting = new Setting(contentEl)
      .setName(t("modal_import_password_label"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text.setPlaceholder(t("modal_export_password_placeholder")).onChange((v) => {
          password = v;
        });
      });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText(t("modal_import_button")).setCta().onClick(async () => {
        if (!fileContent) {
          new Notice(t("modal_import_no_file"));
          return;
        }
        const result = await importSettingsFromJSON(fileContent, password);
        if (result.status === "ok") {
          Object.assign(this.plugin.settings, result.settings);
          await this.plugin.saveSettings();
          new Notice(t("modal_import_success"));
          this.close();
          this.plugin.settingTab?.display();
        } else if (result.status === "wrong_password") {
          new Notice(t("modal_import_wrong_password"));
        } else {
          new Notice(result.message);
        }
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

const wrapTextWithPasswordHide = (text: TextComponent) => {
  const span = createSpan("Hi!");
  const hider = text.inputEl.insertAdjacentElement("beforebegin", span) as HTMLElement;
  // the init type of hider is "hidden" === eyeOff === password
  setIcon(hider, "eye-off");
  hider.addEventListener("click", (e) => {
    const isText = text.inputEl.getAttribute("type") === "text";
    let eyeIcon = isText ? "eye-off" : "eye";
    setIcon(hider, eyeIcon);
    text.inputEl.setAttribute("type", isText ? "password" : "text");
    text.inputEl.focus();
  });

  // the init type of text el is password
  text.inputEl.setAttribute("type", "password");
  return text;
};

export class RemotelySaveSettingTab extends PluginSettingTab {
  readonly plugin: RemotelySavePlugin;
  deletingRemoteMeta: boolean;

  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.deletingRemoteMeta = false;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    //////////////////////////////////////////////////
    // below for service chooser (part 1/2)
    //////////////////////////////////////////////////

    // we need to create the div in advance of any other service divs
    const serviceChooserDiv = containerEl.createDiv();
    serviceChooserDiv.createEl("h2", { text: t("settings_chooseservice") });

    //////////////////////////////////////////////////
    // below for s3
    //////////////////////////////////////////////////

    const s3Div = containerEl.createEl("div", { cls: "s3-hide" });
    s3Div.toggleClass("s3-hide", this.plugin.settings.serviceType !== "s3");
    s3Div.createEl("h2", { text: t("settings_s3") });

    new Setting(s3Div)
      .setName(t("settings_s3_endpoint"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.s3.s3Endpoint)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3Endpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_region"))
      .setDesc(t("settings_s3_region_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3Region}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3Region = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_accesskeyid"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3AccessKeyID}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3AccessKeyID = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_s3_secretaccesskey"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3SecretAccessKey}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3SecretAccessKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(s3Div)
      .setName(t("settings_s3_bucketname"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.s3.s3BucketName}`)
          .onChange(async (value) => {
            this.plugin.settings.s3.s3BucketName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(s3Div)
      .setName(t("settings_s3_urlstyle"))
      .setDesc(t("settings_s3_urlstyle_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption(
          "virtualHostedStyle",
          "Virtual Hosted-Style (default)"
        );
        dropdown.addOption("pathStyle", "Path-Style");
        dropdown
          .setValue(
            this.plugin.settings.s3.forcePathStyle
              ? "pathStyle"
              : "virtualHostedStyle"
          )
          .onChange(async (val: string) => {
            this.plugin.settings.s3.forcePathStyle = val === "pathStyle";
            await this.plugin.saveSettings();
          });
      });

    if (VALID_REQURL) {
      new Setting(s3Div)
        .setName(t("settings_s3_bypasscorslocally"))
        .setDesc(t("settings_s3_bypasscorslocally_desc"))
        .addDropdown((dropdown) => {
          dropdown
            .addOption("disable", t("disable"))
            .addOption("enable", t("enable"));

          dropdown
            .setValue(
              `${this.plugin.settings.s3.bypassCorsLocally ? "enable" : "disable"
              }`
            )
            .onChange(async (value) => {
              if (value === "enable") {
                this.plugin.settings.s3.bypassCorsLocally = true;
              } else {
                this.plugin.settings.s3.bypassCorsLocally = false;
              }
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(s3Div)
      .setName(t("settings_s3_parts"))
      .setDesc(t("settings_s3_parts_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("1", "1");
        dropdown.addOption("2", "2");
        dropdown.addOption("3", "3");
        dropdown.addOption("5", "5");
        dropdown.addOption("10", "10");
        dropdown.addOption("15", "15");
        dropdown.addOption("20", "20 (default)");

        dropdown
          .setValue(`${this.plugin.settings.s3.partsConcurrency}`)
          .onChange(async (val) => {
            const realVal = parseInt(val);
            this.plugin.settings.s3.partsConcurrency = realVal;
            await this.plugin.saveSettings();
          });
      });



    //////////////////////////////////////////////////
    // below for dropbpx
    //////////////////////////////////////////////////

    const dropboxDiv = containerEl.createEl("div", { cls: "dropbox-hide" });
    dropboxDiv.toggleClass(
      "dropbox-hide",
      this.plugin.settings.serviceType !== "dropbox"
    );
    dropboxDiv.createEl("h2", { text: t("settings_dropbox") });

    const dropboxLongDescDiv = dropboxDiv.createEl("div", {
      cls: "settings-long-desc",
    });
    for (const c of [
      t("settings_dropbox_disclaimer1"),
      t("settings_dropbox_disclaimer2"),
    ]) {
      dropboxLongDescDiv.createEl("p", {
        text: c,
        cls: "dropbox-disclaimer",
      });
    }
    dropboxLongDescDiv.createEl("p", {
      text: t("settings_dropbox_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.dropbox.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    const dropboxSelectAuthDiv = dropboxDiv.createDiv();
    const dropboxAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: "dropbox-auth-button-hide settings-auth-related",
    });
    const dropboxRevokeAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: "dropbox-revoke-auth-button-hide settings-auth-related",
    });

    const dropboxRevokeAuthSetting = new Setting(dropboxRevokeAuthDiv)
      .setName(t("settings_dropbox_revoke"))
      .setDesc(
        t("settings_dropbox_revoke_desc", {
          username: this.plugin.settings.dropbox.username,
        })
      )
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_revoke_button"));
        button.onClick(async () => {
          try {
            const self = this;
            const client = new FakeFsDropbox(
              this.plugin.settings.dropbox,
              this.app.vault.getName(),
              () => self.plugin.saveSettings()
            );
            await client.revokeAuth();
            this.plugin.settings.dropbox = JSON.parse(
              JSON.stringify(DEFAULT_DROPBOX_CONFIG)
            );
            await this.plugin.saveSettings();
            dropboxAuthDiv.toggleClass(
              "dropbox-auth-button-hide",
              this.plugin.settings.dropbox.username !== ""
            );
            dropboxRevokeAuthDiv.toggleClass(
              "dropbox-revoke-auth-button-hide",
              this.plugin.settings.dropbox.username === ""
            );
            new Notice(t("settings_dropbox_revoke_notice"));
          } catch (err) {
            console.error(err);
            new Notice(t("settings_dropbox_revoke_noticeerr"));
          }
        });
      });

    new Setting(dropboxRevokeAuthDiv)
      .setName(t("settings_dropbox_clearlocal"))
      .setDesc(t("settings_dropbox_clearlocal_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_clearlocal_button"));
        button.onClick(async () => {
          this.plugin.settings.dropbox = JSON.parse(
            JSON.stringify(DEFAULT_DROPBOX_CONFIG)
          );
          await this.plugin.saveSettings();
          dropboxAuthDiv.toggleClass(
            "dropbox-auth-button-hide",
            this.plugin.settings.dropbox.username !== ""
          );
          dropboxRevokeAuthDiv.toggleClass(
            "dropbox-revoke-auth-button-hide",
            this.plugin.settings.dropbox.username === ""
          );
          new Notice(t("settings_dropbox_clearlocal_notice"));
        });
      });

    new Setting(dropboxAuthDiv)
      .setName(t("settings_dropbox_auth"))
      .setDesc(t("settings_dropbox_auth_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_dropbox_auth_button"));
        button.onClick(async () => {
          const modal = new DropboxAuthModal(
            this.app,
            this.plugin,
            dropboxAuthDiv,
            dropboxRevokeAuthDiv,
            dropboxRevokeAuthSetting
          );
          this.plugin.oauth2Info.helperModal = modal;
          this.plugin.oauth2Info.authDiv = dropboxAuthDiv;
          this.plugin.oauth2Info.revokeDiv = dropboxRevokeAuthDiv;
          this.plugin.oauth2Info.revokeAuthSetting = dropboxRevokeAuthSetting;
          modal.open();
        });
      });

    dropboxAuthDiv.toggleClass(
      "dropbox-auth-button-hide",
      this.plugin.settings.dropbox.username !== ""
    );
    dropboxRevokeAuthDiv.toggleClass(
      "dropbox-revoke-auth-button-hide",
      this.plugin.settings.dropbox.username === ""
    );

    let newDropboxRemoteBaseDir =
      this.plugin.settings.dropbox.remoteBaseDir || "";
    new Setting(dropboxDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newDropboxRemoteBaseDir)
          .onChange((value) => {
            newDropboxRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newDropboxRemoteBaseDir,
            "dropbox"
          ).open();
        });
      });


    //////////////////////////////////////////////////
    // below for onedrive
    //////////////////////////////////////////////////

    const onedriveDiv = containerEl.createEl("div", { cls: "onedrive-hide" });
    onedriveDiv.toggleClass(
      "onedrive-hide",
      this.plugin.settings.serviceType !== "onedrive"
    );
    onedriveDiv.createEl("h2", { text: t("settings_onedrive") });
    const onedriveLongDescDiv = onedriveDiv.createEl("div", {
      cls: "settings-long-desc",
    });
    for (const c of [
      t("settings_onedrive_disclaimer1"),
      t("settings_onedrive_disclaimer2"),
    ]) {
      onedriveLongDescDiv.createEl("p", {
        text: c,
        cls: "onedrive-disclaimer",
      });
    }

    onedriveLongDescDiv.createEl("p", {
      text: t("settings_onedrive_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.onedrive.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    onedriveLongDescDiv.createEl("p", {
      text: t("settings_onedrive_nobiz"),
    });

    const onedriveSelectAuthDiv = onedriveDiv.createDiv();
    const onedriveAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-auth-button-hide settings-auth-related",
    });
    const onedriveRevokeAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-revoke-auth-button-hide settings-auth-related",
    });

    const onedriveRevokeAuthSetting = new Setting(onedriveRevokeAuthDiv)
      .setName(t("settings_onedrive_revoke"))
      .setDesc(
        t("settings_onedrive_revoke_desc", {
          username: this.plugin.settings.onedrive.username,
        })
      )
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_revoke_button"));
        button.onClick(async () => {
          new OnedriveRevokeAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv
          ).open();
        });
      });

    new Setting(onedriveAuthDiv)
      .setName(t("settings_onedrive_auth"))
      .setDesc(t("settings_onedrive_auth_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_auth_button"));
        button.onClick(async () => {
          const modal = new OnedriveAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv,
            onedriveRevokeAuthSetting
          );
          this.plugin.oauth2Info.helperModal = modal;
          this.plugin.oauth2Info.authDiv = onedriveAuthDiv;
          this.plugin.oauth2Info.revokeDiv = onedriveRevokeAuthDiv;
          this.plugin.oauth2Info.revokeAuthSetting = onedriveRevokeAuthSetting;
          modal.open();
        });
      });

    onedriveAuthDiv.toggleClass(
      "onedrive-auth-button-hide",
      this.plugin.settings.onedrive.username !== ""
    );
    onedriveRevokeAuthDiv.toggleClass(
      "onedrive-revoke-auth-button-hide",
      this.plugin.settings.onedrive.username === ""
    );

    let newOnedriveRemoteBaseDir =
      this.plugin.settings.onedrive.remoteBaseDir || "";
    new Setting(onedriveDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newOnedriveRemoteBaseDir)
          .onChange((value) => {
            newOnedriveRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newOnedriveRemoteBaseDir,
            "onedrive"
          ).open();
        });
      });


    //////////////////////////////////////////////////
    // below for webdav
    //////////////////////////////////////////////////

    const webdavDiv = containerEl.createEl("div", { cls: "webdav-hide" });
    webdavDiv.toggleClass(
      "webdav-hide",
      this.plugin.settings.serviceType !== "webdav"
    );

    webdavDiv.createEl("h2", { text: t("settings_webdav") });

    const webdavLongDescDiv = webdavDiv.createEl("div", {
      cls: "settings-long-desc",
    });

    webdavLongDescDiv.createEl("p", {
      text: t("settings_webdav_disclaimer1"),
      cls: "webdav-disclaimer",
    });

    if (!VALID_REQURL) {
      webdavLongDescDiv.createEl("p", {
        text: t("settings_webdav_cors_os"),
      });

      webdavLongDescDiv.createEl("p", {
        text: t("settings_webdav_cors"),
      });
    }

    webdavLongDescDiv.createEl("p", {
      text: t("settings_webdav_folder", {
        remoteBaseDir:
          this.plugin.settings.webdav.remoteBaseDir || this.app.vault.getName(),
      }),
    });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_addr"))
      .setDesc(t("settings_webdav_addr_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.address)
          .onChange(async (value) => {
            this.plugin.settings.webdav.address = value.trim();
            if (
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity"
            ) {
              this.plugin.settings.webdav.depth = "auto_unknown";
            }

            // TODO: any more elegant way?
            applyWebdavPresetRulesInplace(this.plugin.settings.webdav);

            // normally saved
            await this.plugin.saveSettings();
          })
      );

    new Setting(webdavDiv)
      .setName(t("settings_webdav_user"))
      .setDesc(t("settings_webdav_user_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.username)
          .onChange(async (value) => {
            this.plugin.settings.webdav.username = value.trim();
            if (
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity"
            ) {
              this.plugin.settings.webdav.depth = "auto_unknown";
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_password"))
      .setDesc(t("settings_webdav_password_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.webdav.password)
          .onChange(async (value) => {
            this.plugin.settings.webdav.password = value.trim();
            if (
              this.plugin.settings.webdav.depth === "auto_1" ||
              this.plugin.settings.webdav.depth === "auto_infinity"
            ) {
              this.plugin.settings.webdav.depth = "auto_unknown";
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_auth"))
      .setDesc(t("settings_webdav_auth_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("basic", "basic");
        if (VALID_REQURL) {
          dropdown.addOption("digest", "digest");
        }

        // new version config, copied to old version, we need to reset it
        if (!VALID_REQURL && this.plugin.settings.webdav.authType !== "basic") {
          this.plugin.settings.webdav.authType = "basic";
          await this.plugin.saveSettings();
        }

        dropdown
          .setValue(this.plugin.settings.webdav.authType)
          .onChange(async (val: WebdavAuthType) => {
            this.plugin.settings.webdav.authType = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(webdavDiv)
      .setName(t("settings_webdav_depth"))
      .setDesc(t("settings_webdav_depth_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", t("settings_webdav_depth_auto"));
        dropdown.addOption("manual_1", t("settings_webdav_depth_1"));
        dropdown.addOption("manual_infinity", t("settings_webdav_depth_inf"));

        let initVal = "auto";
        const autoOptions: Set<WebdavDepthType> = new Set([
          "auto_unknown",
          "auto_1",
          "auto_infinity",
        ]);
        if (autoOptions.has(this.plugin.settings.webdav.depth)) {
          initVal = "auto";
        } else {
          initVal = this.plugin.settings.webdav.depth || "auto";
        }

        type DepthOption = "auto" | "manual_1" | "manual_infinity";
        dropdown.setValue(initVal).onChange(async (val: DepthOption) => {
          if (val === "auto") {
            this.plugin.settings.webdav.depth = "auto_unknown";
            this.plugin.settings.webdav.manualRecursive = false;
          } else if (val === "manual_1") {
            this.plugin.settings.webdav.depth = "manual_1";
            this.plugin.settings.webdav.manualRecursive = true;
          } else if (val === "manual_infinity") {
            this.plugin.settings.webdav.depth = "manual_infinity";
            this.plugin.settings.webdav.manualRecursive = false;
          }

          // TODO: any more elegant way?
          applyWebdavPresetRulesInplace(this.plugin.settings.webdav);

          // normally save
          await this.plugin.saveSettings();
        });
      });

    let newWebdavRemoteBaseDir =
      this.plugin.settings.webdav.remoteBaseDir || "";
    new Setting(webdavDiv)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newWebdavRemoteBaseDir)
          .onChange((value) => {
            newWebdavRemoteBaseDir = value.trim();
          })
      )
      .addButton((button) => {
        button.setButtonText(t("confirm"));
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newWebdavRemoteBaseDir,
            "webdav"
          ).open();
        });
      });


    //////////////////////////////////////////////////
    // below for general chooser (part 2/2)
    //////////////////////////////////////////////////

    // we need to create chooser
    // after all service-div-s being created
    new Setting(serviceChooserDiv)
      .setName(t("settings_chooseservice"))
      .setDesc(t("settings_chooseservice_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("s3", t("settings_chooseservice_s3"));
        dropdown.addOption("dropbox", t("settings_chooseservice_dropbox"));
        dropdown.addOption("webdav", t("settings_chooseservice_webdav"));
        dropdown.addOption("onedrive", t("settings_chooseservice_onedrive"));
        dropdown
          .setValue(this.plugin.settings.serviceType)
          .onChange(async (val: SUPPORTED_SERVICES_TYPE) => {
            this.plugin.settings.serviceType = val;
            s3Div.toggleClass(
              "s3-hide",
              this.plugin.settings.serviceType !== "s3"
            );
            dropboxDiv.toggleClass(
              "dropbox-hide",
              this.plugin.settings.serviceType !== "dropbox"
            );
            onedriveDiv.toggleClass(
              "onedrive-hide",
              this.plugin.settings.serviceType !== "onedrive"
            );
            webdavDiv.toggleClass(
              "webdav-hide",
              this.plugin.settings.serviceType !== "webdav"
            );
            await this.plugin.saveSettings();
          });
      });

    //////////////////////////////////////////////////
    // below for encryption settings
    //////////////////////////////////////////////////

    const encryptionDiv = containerEl.createEl("div", { cls: "encryption-section" });
    encryptionDiv.createEl("h2", { text: t("settings_encryption") });

    let newPassword = `${this.plugin.settings.password}`;
    new Setting(encryptionDiv)
      .setName(t("settings_password"))
      .setDesc(t("settings_password_desc"))
      .addText((text) => {
        wrapTextWithPasswordHide(text);
        text
          .setPlaceholder("")
          .setValue(`${this.plugin.settings.password}`)
          .onChange(async (value) => {
            newPassword = value.trim();
          });
      })
      .addButton(async (button) => {
        button.setButtonText(t("confirm"));
        button.onClick(async () => {
          new PasswordModal(this.app, this.plugin, newPassword).open();
        });
      });

    new Setting(encryptionDiv)
      .setName(t("settings_encryptionmethod"))
      .setDesc("AES-256-GCM is the default. rclone is compatible with rclone-encrypted remotes.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("aes-256-gcm", "AES-256-GCM (default)")
          .addOption("rclone", "rclone-compatible")
          .setValue(this.plugin.settings.cipherMethod ?? "aes-256-gcm")
          .onChange(async (value) => {
            this.plugin.settings.cipherMethod = value as any;
            await this.plugin.saveSettings();
          });
      });

    const checkConnDiv = containerEl.createEl("div", { cls: "check-conn-section" });
    new Setting(checkConnDiv)
      .setName(t("settings_check_connectivity"))
      .setDesc(t("settings_check_connectivity_desc"))
      .addButton((button) => {
        button.setButtonText(t("settings_check_connectivity_button"));
        button.onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Checking...");
          try {
            const client = getClient(
              this.plugin.settings,
              this.app.vault.getName(),
              () => this.plugin.saveSettings()
            );
            let connFailed = false;
            await client.checkConnect((callbackObject: any) => {
              if (callbackObject.hasOwnProperty("err")) {
                log.error(`[checkConn] callback err:`, callbackObject.err);
                connFailed = true;
              }
            });
            if (connFailed) {
              new Notice(t("settings_check_conn_fail"));
              return;
            }
            const password = this.plugin.settings.password ?? "";
            if (password !== "") {
              const encFs = new FakeFsEncrypt(
                client,
                password,
                this.plugin.settings.cipherMethod ?? "aes-256-gcm"
              );
              const passwordResult = await encFs.isPasswordOk();
              if (passwordResult.ok) {
                if (passwordResult.reason === "empty_remote") {
                  new Notice(t("settings_check_enc_empty_remote"));
                } else if (passwordResult.reason === "password_matched") {
                  new Notice(`${t("settings_check_conn_ok")} ${t("settings_check_enc_ok")}`);
                } else {
                  new Notice(t("settings_check_conn_ok"));
                }
              } else {
                if (passwordResult.reason === "password_or_method_not_matched_or_remote_not_encrypted") {
                  new Notice(t("settings_check_enc_wrong_pw"));
                } else if (passwordResult.reason === "encryption_method_not_matched") {
                  new Notice(t("settings_check_enc_wrong_method"));
                } else if (passwordResult.reason === "remote_encrypted_local_no_password") {
                  new Notice(t("settings_check_enc_remote_has_pw_local_none"));
                } else {
                  new Notice(t("settings_check_enc_fail"));
                }
              }
            } else {
              new Notice(t("settings_check_conn_ok"));
            }
          } catch (e: any) {
            log.error(`[checkConn] threw:`, e?.message, e?.stack);
            new Notice(t("settings_check_conn_fail"));
          } finally {
            button.setDisabled(false);
            button.setButtonText(t("settings_check_connectivity_button"));
          }
        });
      });

    //////////////////////////////////////////////////
    // below for sync settings
    //////////////////////////////////////////////////

    const syncDiv = containerEl.createEl("div");
    syncDiv.createEl("h2", { text: t("settings_sync") });

    new Setting(syncDiv)
      .setName(t("settings_autorun"))
      .setDesc(t("settings_autorun_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_autorun_notset"));
        dropdown.addOption(`${1000 * 5}`, t("settings_autorun_second", { "time": 5 }));
        dropdown.addOption(`${1000 * 15}`, t("settings_autorun_second", { "time": 15 }));
        dropdown.addOption(`${1000 * 30}`, t("settings_autorun_second", { "time": 30 }));
        dropdown.addOption(`${1000 * 60}`, t("settings_autorun_1min"));
        dropdown.addOption(`${1000 * 60 * 5}`, t("settings_autorun_5min"));
        dropdown.addOption(`${1000 * 60 * 10}`, t("settings_autorun_10min"));
        dropdown.addOption(`${1000 * 60 * 30}`, t("settings_autorun_30min"));

        dropdown
          .setValue(`${this.plugin.settings.autoRunEveryMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = parseInt(val);
            this.plugin.settings.autoRunEveryMilliseconds = realVal;
            await this.plugin.saveSettings();
            if (
              (realVal === undefined || realVal === null || realVal <= 0) &&
              this.plugin.autoRunIntervalID !== undefined
            ) {
              window.clearInterval(this.plugin.autoRunIntervalID);
              this.plugin.autoRunIntervalID = undefined;
            } else if (
              realVal !== undefined &&
              realVal !== null &&
              realVal > 0
            ) {
              const intervalID = window.setInterval(() => {
                this.plugin.syncRun("auto");
              }, realVal);
              this.plugin.autoRunIntervalID = intervalID;
              this.plugin.registerInterval(intervalID);
            }
          });
      });

    new Setting(syncDiv)
      .setName(t("settings_runoncestartup"))
      .setDesc(t("settings_runoncestartup_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_runoncestartup_notset"));
        dropdown.addOption(
          `${1000 * 1 * 1}`,
          t("settings_runoncestartup_1sec")
        );
        dropdown.addOption(
          `${1000 * 10 * 1}`,
          t("settings_runoncestartup_10sec")
        );
        dropdown.addOption(
          `${1000 * 30 * 1}`,
          t("settings_runoncestartup_30sec")
        );
        dropdown
          .setValue(`${this.plugin.settings.initRunAfterMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = parseInt(val);
            this.plugin.settings.initRunAfterMilliseconds = realVal;
            await this.plugin.saveSettings();
          });
      });

    new Setting(syncDiv)
      .setName(t("settings_saverun"))
      .setDesc(t("settings_saverun_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_saverun_notset"));
        dropdown.addOption("0", t("settings_saverun_instant"));
        dropdown.addOption(`${1000 * 5}`, t("settings_saverun_5sec"));
        dropdown.addOption(`${1000 * 10}`, t("settings_saverun_10sec"));
        dropdown.addOption(`${1000 * 30}`, t("settings_saverun_30sec"));
        dropdown.addOption(`${1000 * 60}`, t("settings_saverun_1min"));
        dropdown
          .setValue(`${this.plugin.settings.syncOnSaveAfterMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = parseInt(val);
            this.plugin.settings.syncOnSaveAfterMilliseconds = realVal;
            await this.plugin.saveSettings();
            if (realVal < 0) {
              this.plugin.toggleSyncOnSave(false);
            } else {
              this.plugin.toggleSyncOnSave(true);
            }
          });
      });

    new Setting(syncDiv)
      .setName(t("settings_remoterun"))
      .setDesc(t("settings_remoterun_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_remoterun_notset"));
        dropdown.addOption(`${1000 * 1}`, t("settings_remoterun_1sec"));
        dropdown.addOption(`${1000 * 5}`, t("settings_remoterun_5sec"));
        dropdown.addOption(`${1000 * 10}`, t("settings_remoterun_10sec"));
        dropdown.addOption(`${1000 * 60}`, t("settings_remoterun_1min"));
        dropdown
          .setValue(`${this.plugin.settings.syncOnRemoteChangesAfterMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = parseInt(val);
            this.plugin.settings.syncOnRemoteChangesAfterMilliseconds = realVal;
            await this.plugin.saveSettings();
            if (realVal <= 0) {
              this.plugin.toggleSyncOnRemote(false);
            } else {
              this.plugin.toggleSyncOnRemote(true);
            }
          });
      });

    new Setting(syncDiv)
      .setName(t("settings_skiplargefiles"))
      .setDesc(t("settings_skiplargefiles_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_skiplargefiles_notset"));
        const mbs = [1, 5, 10, 50, 100, 500, 1000];
        for (const mb of mbs) {
          dropdown.addOption(`${mb * 1000 * 1000}`, `${mb} MB`);
        }
        dropdown
          .setValue(`${this.plugin.settings.skipSizeLargerThan}`)
          .onChange(async (val) => {
            this.plugin.settings.skipSizeLargerThan = parseInt(val);
            await this.plugin.saveSettings();
          });
      });

    if (Platform.isDesktopApp) {
      new Setting(syncDiv)
        .setName(t("settings_enablestatusbar_info"))
        .setDesc(t("settings_enablestatusbar_info_desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.enableStatusBarInfo)
            .onChange(async (val) => {
              this.plugin.settings.enableStatusBarInfo = val;
              await this.plugin.saveSettings();
              this.plugin.toggleStatusBar(val);
              statusBarOptions.toggleClass(
                "remotely-sync-hidden",
                this.plugin.settings.enableStatusBarInfo !== true
              );
            });
        });

      const statusBarOptions = syncDiv.createDiv({ cls: "remotely-sync-hidden" });
      statusBarOptions.toggleClass(
        "remotely-sync-hidden",
        this.plugin.settings.enableStatusBarInfo !== true
      );

      new Setting(statusBarOptions)
        .setName(t("settings_showlastsyncedonly"))
        .setDesc(t("settings_showlastsyncedonly_desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.showLastSyncedOnly)
            .onChange(async (val) => {
              this.plugin.settings.showLastSyncedOnly = val;
              await this.plugin.saveSettings();
              this.plugin.toggleStatusBar(true);
              this.plugin.toggleStatusBarObserver(val);
            });
        });
    }

    // Excluded paths textarea
    if (!this.plugin.settings.ignorePaths) {
      this.plugin.settings.ignorePaths = [];
    }

    const ignorePathsSetting = new Setting(syncDiv)
      .setName(t("settings_ignorepaths"))
      .setDesc(t("settings_ignorepaths_desc"));

    const ignoreTextarea = ignorePathsSetting.settingEl.createEl("textarea", { cls: "ignore-paths-textarea" });
    ignoreTextarea.value = this.plugin.settings.ignorePaths.join("\n");
    ignoreTextarea.placeholder = ".trash\n.obsidian\n^_.*";
    ignoreTextarea.rows = 6;
    ignoreTextarea.addEventListener("blur", async () => {
      this.plugin.settings.ignorePaths = ignoreTextarea.value
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      await this.plugin.saveSettings();
    });

    //////////////////////////////////////////////////
    // below for import and export functions
    //////////////////////////////////////////////////

    // import and export
    const importExportDiv = containerEl.createEl("div");
    importExportDiv.createEl("h2", {
      text: t("settings_importexport"),
    });

    new Setting(importExportDiv)
      .setName(t("settings_importexport_title"))
      .setDesc(t("settings_importexport_desc"))
      .addButton((button) => {
        button.setButtonText(t("settings_export_desc_button"));
        button.onClick(() => {
          new ExportSettingsModal(this.app, this.plugin).open();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("modal_import_button"));
        button.onClick(() => {
          new ImportSettingsModal(this.app, this.plugin).open();
        });
      });

    //////////////////////////////////////////////////
    // below for advanced settings
    //////////////////////////////////////////////////
    const advDetails = containerEl.createEl("details", { cls: "collapsible-section" });
    const advSummary = advDetails.createEl("summary", { cls: "collapsible-section-summary" });
    advSummary.createEl("h2", { cls: "collapsible-section-h2", text: t("settings_adv") });
    const advDiv = advDetails;

    new Setting(advDiv)
      .setName("Sync direction")
      .setDesc("Bidirectional syncs both ways. Push-only uploads local changes. Pull-only downloads remote changes.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("bidirectional", "Bidirectional (default)")
          .addOption("incremental_push_only", "Push only")
          .addOption("incremental_pull_only", "Pull only")
          .setValue(this.plugin.settings.syncDirection ?? "bidirectional")
          .onChange(async (value) => {
            this.plugin.settings.syncDirection = value as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(advDiv)
      .setName("Conflict resolution")
      .setDesc("How to handle conflicting changes. Smart conflict merges markdown files using 3-way merge.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("smart_conflict", "Smart conflict (3-way merge)")
          .addOption("keep_newer", "Keep newer")
          .addOption("keep_larger", "Keep larger")
          .addOption("keep_remote", "Keep remote")
          .addOption("keep_local", "Keep local")
          .setValue(this.plugin.settings.conflictAction ?? "smart_conflict")
          .onChange(async (value) => {
            this.plugin.settings.conflictAction = value as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(advDiv)
      .setName(t("settings_concurrency"))
      .setDesc(t("settings_concurrency_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("1", "1");
        dropdown.addOption("2", "2");
        dropdown.addOption("3", "3");
        dropdown.addOption("5", "5 (default)");
        dropdown.addOption("10", "10");
        dropdown.addOption("15", "15");
        dropdown.addOption("20", "20");

        dropdown
          .setValue(`${this.plugin.settings.concurrency}`)
          .onChange(async (val) => {
            const realVal = parseInt(val);
            this.plugin.settings.concurrency = realVal;
            await this.plugin.saveSettings();
          });
      });



    //////////////////////////////////////////////////
    // below for debug
    //////////////////////////////////////////////////

    const debugDetails = containerEl.createEl("details", { cls: "debug-section" });
    const debugSummary = debugDetails.createEl("summary", { cls: "debug-section-summary" });
    debugSummary.createEl("h2", { cls: "debug-section-h2", text: t("settings_debug") });
    const debugDiv = debugDetails;

    new Setting(debugDiv)
      .setName(t("settings_debug_enabled"))
      .setDesc(t("settings_debug_enabled_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(this.plugin.settings.debugEnabled ? "enable" : "disable")
          .onChange(async (val: string) => {
            const debugEnabled = val === "enable";
            this.plugin.settings.debugEnabled = debugEnabled;
            if (debugEnabled) {
              log.setLevel("debug");
            } else {
              log.setLevel("info");
            }
            
            await this.plugin.saveSettings();
          });
      });

    new Setting(debugDiv)
      .setName(t("settings_outputsettingsconsole"))
      .setDesc(t("settings_outputsettingsconsole_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_outputsettingsconsole_button"));
        button.onClick(async () => {
          const c = messyConfigToNormal(await this.plugin.loadData());
          console.log("=== Another Obsidian Sync: Debug Info ===");
          console.log("Vault path:", this.plugin.getVaultBasePath());
          console.log("Vault ID:", this.plugin.vaultRandomID);
          console.log("Settings:", c);
          new Notice(t("settings_outputsettingsconsole_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_logtodb"))
      .setDesc(t("settings_logtodb_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("enable", t("enable"));
        dropdown.addOption("disable", t("disable"));
        dropdown
          .setValue(this.plugin.settings.logToDB ? "enable" : "disable")
          .onChange(async (val: string) => {
            const logToDB = val === "enable";
            if (logToDB) {
              applyLogWriterInplace((...msg: any[]) => {
                insertLoggerOutputByVault(
                  this.plugin.db,
                  this.plugin.vaultRandomID,
                  ...msg
                );
              });
            } else {
              restoreLogWritterInplace();
            }
            clearExpiredLoggerOutputRecords(this.plugin.db);
            this.plugin.settings.logToDB = logToDB;
            await this.plugin.saveSettings();
          });
      });

    new Setting(debugDiv)
      .setName(t("settings_logtodbexport"))
      .setDesc(t("settings_logtodbexport_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_logtodbexport_button"));
        button.onClick(async () => {
          await exportVaultLoggerOutputToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID
          );
          new Notice(t("settings_logtodbexport_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_logtodbclear"))
      .setDesc(t("settings_logtodbclear_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_logtodbclear_button"));
        button.onClick(async () => {
          await clearAllLoggerOutputRecords(this.plugin.db);
          new Notice(t("settings_logtodbclear_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_syncplans"))
      .setDesc(t("settings_syncplans_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_syncplans_button_json"));
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            "json"
          );
          new Notice(t("settings_syncplans_notice"));
        });
      })
      .addButton(async (button) => {
        button.setButtonText(t("settings_syncplans_button_table"));
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            "table"
          );
          new Notice(t("settings_syncplans_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_delsyncplans"))
      .setDesc(t("settings_delsyncplans_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_delsyncplans_button"));
        button.onClick(async () => {
          await clearAllSyncPlanRecords(this.plugin.db);
          new Notice(t("settings_delsyncplans_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_delsyncmap"))
      .setDesc(t("settings_delsyncmap_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_delsyncmap_button"));
        button.onClick(async () => {
          await clearAllSyncMetaMapping(this.plugin.db);
          new Notice(t("settings_delsyncmap_notice"));
        });
      });

    new Setting(debugDiv)
      .setName(t("settings_disable_s3_metadata_sync"))
      .setDesc(t("settings_disable_s3_metadata_sync_desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.s3.disableS3MetadataSync)
          .onChange(async (val) => {
            this.plugin.settings.s3.disableS3MetadataSync = val;
            await this.plugin.saveSettings();
            new Notice(t("settings_enablestatusbar_reloadrequired_notice"));
          });
      });

    new Setting(debugDiv)
      .setName(t("settings_reset_sync_metadata"))
      .setDesc(t("settings_reset_sync_metadata_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_reset_button"));
        button.onClick(async () => {
          // Delete all remote metadata file(s) and upload empty one.
          if (this.deletingRemoteMeta) {
            new Notice(t("settings_reset_sync_metadata_notice_error"));
            return;
          }

          new Notice(t("settings_reset_sync_metadata_notice_start"))
          log.debug("Deleting remote metadata file. (1/2)")

          this.deletingRemoteMeta = true;

          await this.deleteRemoteMetadata();

          this.deletingRemoteMeta = false;

          new Notice(t("settings_reset_sync_metadata_notice_end"));
          log.debug("Remote metadata file deleted. (2/2)")
        });
      });
  }

  private async deleteRemoteMetadata() {
    const client = getClient(
      this.plugin.settings,
      this.app.vault.getName(),
      () => this.plugin.saveSettings()
    );
    try {
      await client.rm(DEFAULT_FILE_NAME_FOR_METADATAONREMOTE);
    } catch (e) {
      log.debug(`deleteRemoteMetadata: could not delete ${DEFAULT_FILE_NAME_FOR_METADATAONREMOTE}: ${e}`);
    }
    try {
      await client.rm(DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2);
    } catch (e) {
      log.debug(`deleteRemoteMetadata: could not delete ${DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2}: ${e}`);
    }
  }

  hide() {
    let { containerEl } = this;
    containerEl.empty();
    super.hide();
  }
}
