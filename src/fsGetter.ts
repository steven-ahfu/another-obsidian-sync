import { log } from "./moreOnLog";
import type { RemotelySavePluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsDropbox } from "./fsDropbox";
import { FakeFsOnedrive } from "./fsOnedrive";
import { FakeFsProtondrive } from "./fsProtondrive";
import { FakeFsS3 } from "./fsS3";
import { FakeFsWebdav } from "./fsWebdav";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>
): FakeFs {
  log.debug(
    `[fsGetter] creating client for serviceType=${settings.serviceType}`
  );
  switch (settings.serviceType) {
    case "s3":
      return new FakeFsS3(
        settings.s3,
        vaultName,
        settings.s3.bypassCorsLocally ?? true
      );
    case "webdav":
      return new FakeFsWebdav(
        settings.webdav,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "dropbox":
      return new FakeFsDropbox(
        settings.dropbox,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "onedrive":
      return new FakeFsOnedrive(
        settings.onedrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    case "protondrive":
      return new FakeFsProtondrive(
        settings.protondrive,
        saveUpdatedConfigFunc
      );
    default:
      throw new Error(
        `cannot init client for serviceType=${settings.serviceType}`
      );
  }
}
