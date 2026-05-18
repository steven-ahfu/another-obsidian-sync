import type { RemotelySavePluginSettings } from "./baseTypes";
import { FakeFs } from "./fsAll";
import { FakeFsDropbox } from "./fsDropbox";
import { FakeFsOnedrive } from "./fsOnedrive";
import { FakeFsS3 } from "./fsS3";
import { FakeFsWebdav } from "./fsWebdav";
import { log } from "./moreOnLog";

export const getClient = (
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>
): FakeFs => {
  log.debug(`[fsGetter] getClient: serviceType=${settings.serviceType}`);
  if (settings.serviceType === "s3") {
    return new FakeFsS3(settings.s3, vaultName, settings.s3.bypassCorsLocally ?? true);
  } else if (settings.serviceType === "webdav") {
    return new FakeFsWebdav(settings.webdav, vaultName, saveUpdatedConfigFunc);
  } else if (settings.serviceType === "dropbox") {
    return new FakeFsDropbox(
      settings.dropbox,
      vaultName,
      saveUpdatedConfigFunc
    );
  } else if (settings.serviceType === "onedrive") {
    return new FakeFsOnedrive(
      settings.onedrive,
      vaultName,
      saveUpdatedConfigFunc
    );
  }
  throw new Error(`Unsupported service type: ${settings.serviceType}`);
};
