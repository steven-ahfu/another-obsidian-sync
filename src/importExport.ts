import cloneDeep from "lodash/cloneDeep";
import { base64url } from "rfc4648";
import { RemotelySavePluginSettings } from "./baseTypes";
import { encryptArrayBuffer, decryptArrayBuffer } from "./encrypt";
import { bufferToArrayBuffer } from "./misc";

const EXPORT_VERSION = 1;

interface ExportFileUnencrypted {
  version: number;
  encrypted: false;
  settings: RemotelySavePluginSettings;
}

interface ExportFileEncrypted {
  version: number;
  encrypted: true;
  data: string; // base64url AES-GCM ciphertext
}

type ExportFile = ExportFileUnencrypted | ExportFileEncrypted;

const stripSensitiveOAuthTokens = (settings: RemotelySavePluginSettings) => {
  const s = cloneDeep(settings);
  delete s.vaultRandomID;
  if (s.dropbox) {
    s.dropbox = { ...s.dropbox, accessToken: "", refreshToken: "", username: "" } as any;
  }
  if (s.onedrive) {
    s.onedrive = { ...s.onedrive, accessToken: "", refreshToken: "", username: "" } as any;
  }
  return s;
};

export const exportSettingsToJSON = async (
  settings: RemotelySavePluginSettings,
  password?: string
): Promise<string> => {
  const stripped = stripSensitiveOAuthTokens(settings);

  if (password && password !== "") {
    const plaintext = new TextEncoder().encode(JSON.stringify(stripped));
    const encrypted = await encryptArrayBuffer(bufferToArrayBuffer(plaintext), password);
    const file: ExportFileEncrypted = {
      version: EXPORT_VERSION,
      encrypted: true,
      data: base64url.stringify(new Uint8Array(encrypted), { pad: false }),
    };
    return JSON.stringify(file, null, 2);
  } else {
    const file: ExportFileUnencrypted = {
      version: EXPORT_VERSION,
      encrypted: false,
      settings: stripped,
    };
    return JSON.stringify(file, null, 2);
  }
};

export interface ImportSettingsResult {
  status: "ok" | "error" | "wrong_password";
  message: string;
  settings?: RemotelySavePluginSettings;
  needsPassword?: boolean;
}

export const importSettingsFromJSON = async (
  json: string,
  password?: string
): Promise<ImportSettingsResult> => {
  let file: ExportFile;
  try {
    file = JSON.parse(json);
  } catch (e) {
    return { status: "error", message: "Invalid file: could not parse JSON." };
  }

  if (!file.version || file.encrypted === undefined) {
    return { status: "error", message: "Invalid file: missing required fields." };
  }

  if (!file.encrypted) {
    return { status: "ok", message: "ok", settings: (file as ExportFileUnencrypted).settings };
  }

  // encrypted
  if (!password || password === "") {
    return { status: "error", message: "This file is encrypted. Please enter a password.", needsPassword: true };
  }

  try {
    const cipherBytes = bufferToArrayBuffer(base64url.parse((file as ExportFileEncrypted).data, { loose: true }));
    const decrypted = await decryptArrayBuffer(cipherBytes, password);
    const settings = JSON.parse(new TextDecoder().decode(decrypted));
    return { status: "ok", message: "ok", settings };
  } catch (e) {
    return { status: "wrong_password", message: "Wrong password or corrupted file." };
  }
};

export const exportedSettingsHasOAuthTokens = (settings: RemotelySavePluginSettings) =>
  !!(settings.dropbox?.accessToken || settings.onedrive?.accessToken);
