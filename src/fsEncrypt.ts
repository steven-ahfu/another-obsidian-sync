import type { CipherMethodType, Entity } from "./baseTypes";
import {
  encryptArrayBuffer,
  decryptArrayBuffer,
  encryptStringToBase64url,
  decryptBase64urlToString,
  getSizeFromOrigToEnc,
} from "./encrypt";
import * as rclone from "./encryptRClone";
import { FakeFs } from "./fsAll";
import { log } from "./moreOnLog";

import cloneDeep from "lodash/cloneDeep";

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "empty_remote"
    | "unknown_encryption_method"
    | "remote_encrypted_local_no_password"
    | "password_matched"
    | "password_or_method_not_matched_or_remote_not_encrypted"
    | "likely_no_password_both_sides"
    | "encryption_method_not_matched";
}

/**
 * Useful if isPasswordEmpty()
 */
function copyEntityAndCopyKeyEncSizeEnc(entity: Entity) {
  const res = cloneDeep(entity);
  res["keyEnc"] = res["key"];
  res["sizeEnc"] = res["size"];
  return res;
}

export class FakeFsEncrypt extends FakeFs {
  readonly serviceType = "encrypt" as const;
  innerFs: FakeFs;
  readonly password: string;
  readonly method: CipherMethodType;
  cipherRClone?: rclone.CipherRclone;
  cacheMapOrigToEnc: Record<string, string>;
  hasCacheMap: boolean;

  constructor(innerFs: FakeFs, password: string, cipherMethod: CipherMethodType) {
    super();
    this.innerFs = innerFs;
    this.password = password ?? "";
    this.method = cipherMethod;
    this.cacheMapOrigToEnc = {};
    this.hasCacheMap = false;

    log.debug(`[fsEncrypt] created with cipherMethod=${cipherMethod} passwordEmpty=${password === ""}`);

    if (this.password !== "" && cipherMethod === "rclone") {
      // no need to init if no password or not rclone
      this.cipherRClone = new rclone.CipherRclone(password, 5);
    }
  }

  isPasswordEmpty() {
    return this.password === "";
  }

  isFolderAware() {
    if (this.method === "aes-256-gcm") {
      return false;
    }
    if (this.method === "rclone") {
      return true;
    }
    throw Error(`no idea about isFolderAware for method=${this.method}`);
  }

  async isPasswordOk(): Promise<PasswordCheckType> {
    const innerWalkResult = await this.walkPartial();

    if (innerWalkResult === undefined || innerWalkResult.length === 0) {
      return {
        ok: true,
        reason: "empty_remote",
      };
    }
    const santyCheckKey = innerWalkResult[0].key;

    if (this.isPasswordEmpty()) {
      return {
        ok: true,
        reason: "likely_no_password_both_sides",
      };
    } else {
      if (this.method === "unknown" as any) {
        return {
          ok: false,
          reason: "unknown_encryption_method",
        };
      }
      try {
        const k = await this._decryptName(santyCheckKey);
        if (k === undefined) {
          throw Error(`decryption failed`);
        }
        return {
          ok: true,
          reason: "password_matched",
        };
      } catch (error) {
        return {
          ok: false,
          reason: "password_or_method_not_matched_or_remote_not_encrypted",
        };
      }
    }
  }

  async walk(): Promise<Entity[]> {
    const innerWalkResult = await this.innerFs.walk();
    return await this._dealWithWalk(innerWalkResult);
  }

  async walkPartial(): Promise<Entity[]> {
    const innerWalkResult = await this.innerFs.walkPartial();
    return await this._dealWithWalk(innerWalkResult);
  }

  async _dealWithWalk(innerWalkResult: Entity[]): Promise<Entity[]> {
    const result: Entity[] = [];

    if (this.isPasswordEmpty()) {
      for (const innerEntity of innerWalkResult) {
        result.push(copyEntityAndCopyKeyEncSizeEnc(innerEntity));
        this.cacheMapOrigToEnc[innerEntity.key] = innerEntity.key;
      }
      this.hasCacheMap = true;
      log.debug(`[fsEncrypt] walk: decrypted ${result.length} entities`);
      return result;
    } else {
      for (const innerEntity of innerWalkResult) {
        const key = await this._decryptName(innerEntity.key);
        const size = key.endsWith("/") ? 0 : undefined;
        result.push({
          key: key,
          keyEnc: innerEntity.key,
          mtimeCli: innerEntity.mtimeCli,
          mtimeSvr: innerEntity.mtimeSvr,
          size: size,
          sizeEnc: innerEntity.size,
          hash: undefined,
          synthesizedFolder: innerEntity.synthesizedFolder,
        });

        this.cacheMapOrigToEnc[key] = innerEntity.key;
      }
      this.hasCacheMap = true;
      log.debug(`[fsEncrypt] walk: decrypted ${result.length} entities`);
      return result;
    }
  }

  async stat(key: string): Promise<Entity> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for stat");
    }
    const keyEnc = this.cacheMapOrigToEnc[key];
    if (keyEnc === undefined) {
      throw new Error(`no encrypted key ${key} before!`);
    }

    const innerEntity = await this.innerFs.stat(keyEnc);
    if (this.isPasswordEmpty()) {
      return copyEntityAndCopyKeyEncSizeEnc(innerEntity);
    } else {
      return {
        key: key,
        keyEnc: innerEntity.key,
        mtimeCli: innerEntity.mtimeCli,
        mtimeSvr: innerEntity.mtimeSvr,
        size: undefined,
        sizeEnc: innerEntity.size,
        hash: undefined,
        synthesizedFolder: innerEntity.synthesizedFolder,
      };
    }
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for mkdir");
    }

    if (!key.endsWith("/")) {
      throw new Error(`should not call mkdir on ${key}`);
    }

    let keyEnc = this.cacheMapOrigToEnc[key];
    if (keyEnc === undefined) {
      if (this.isPasswordEmpty()) {
        keyEnc = key;
      } else {
        keyEnc = await this._encryptName(key);
      }
      this.cacheMapOrigToEnc[key] = keyEnc;
    }

    if (this.isPasswordEmpty() || this.isFolderAware()) {
      const innerEntity = await this.innerFs.mkdir(keyEnc, mtime, ctime);
      return copyEntityAndCopyKeyEncSizeEnc(innerEntity);
    } else {
      const now = Date.now();
      let content = new ArrayBuffer(0);
      if (!this.innerFs.allowEmptyFile()) {
        content = new ArrayBuffer(1);
      }
      const innerEntity = await this.innerFs.writeFile(
        keyEnc,
        content,
        mtime ?? now,
        ctime ?? now
      );
      return {
        key: key,
        keyEnc: innerEntity.key,
        mtimeCli: innerEntity.mtimeCli,
        mtimeSvr: innerEntity.mtimeSvr,
        size: 0,
        sizeEnc: innerEntity.size,
        hash: undefined,
        synthesizedFolder: innerEntity.synthesizedFolder,
      };
    }
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for readFile");
    }
    let keyEnc = this.cacheMapOrigToEnc[key];
    if (keyEnc === undefined) {
      if (this.isPasswordEmpty()) {
        keyEnc = key;
      } else {
        keyEnc = await this._encryptName(key);
      }
      this.cacheMapOrigToEnc[key] = keyEnc;
    }

    log.debug(`[fsEncrypt] writeFile: encrypting key=${key} -> encKey=${keyEnc}`);

    if (this.isPasswordEmpty()) {
      const innerEntity = await this.innerFs.writeFile(
        keyEnc,
        content,
        mtime,
        ctime
      );
      return copyEntityAndCopyKeyEncSizeEnc(innerEntity);
    } else {
      const contentEnc = await this._encryptContent(content);
      const innerEntity = await this.innerFs.writeFile(
        keyEnc,
        contentEnc,
        mtime,
        ctime
      );
      return {
        key: key,
        keyEnc: innerEntity.key,
        mtimeCli: innerEntity.mtimeCli,
        mtimeSvr: innerEntity.mtimeSvr,
        size: undefined,
        sizeEnc: innerEntity.size,
        hash: undefined,
        synthesizedFolder: innerEntity.synthesizedFolder,
      };
    }
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for readFile");
    }
    const keyEnc = this.cacheMapOrigToEnc[key];
    if (keyEnc === undefined) {
      throw new Error(`no encrypted key ${key} before! cannot readFile`);
    }

    log.debug(`[fsEncrypt] readFile: decrypting encKey=${keyEnc} -> key=${key}`);

    const contentEnc = await this.innerFs.readFile(keyEnc);
    if (this.isPasswordEmpty()) {
      return contentEnc;
    } else {
      const res = await this._decryptContent(contentEnc);
      return res;
    }
  }

  async rename(key1: string, key2: string, mtime: number, ctime: number): Promise<void> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for readFile");
    }
    let key1Enc = this.cacheMapOrigToEnc[key1];
    if (key1Enc === undefined) {
      if (this.isPasswordEmpty()) {
        key1Enc = key1;
      } else {
        key1Enc = await this._encryptName(key1);
      }
      this.cacheMapOrigToEnc[key1] = key1Enc;
    }
    let key2Enc = this.cacheMapOrigToEnc[key2];
    if (key2Enc === undefined) {
      if (this.isPasswordEmpty()) {
        key2Enc = key2;
      } else {
        key2Enc = await this._encryptName(key2);
      }
      this.cacheMapOrigToEnc[key2] = key2Enc;
    }
    return await this.innerFs.rename(key1Enc, key2Enc, mtime, ctime);
  }

  async rm(key: string): Promise<void> {
    if (!this.hasCacheMap) {
      throw new Error("You have to build the cacheMap firstly for rm");
    }
    const keyEnc = this.cacheMapOrigToEnc[key];
    if (keyEnc === undefined) {
      throw new Error(`no encrypted key ${key} before! cannot rm`);
    }
    return await this.innerFs.rm(keyEnc);
  }

  async closeResources() {
    if (this.method === "rclone" && this.cipherRClone !== undefined) {
      this.cipherRClone.closeResources();
    }
  }

  async encryptEntity(input: Entity): Promise<Entity> {
    if (input.key === undefined) {
      throw Error(`input entity is abnormal without key`);
    }

    if (this.isPasswordEmpty()) {
      return copyEntityAndCopyKeyEncSizeEnc(input);
    }

    // below is for having password
    const local = cloneDeep(input);
    if (local.sizeEnc === undefined && local.size !== undefined) {
      local.sizeEnc = this._getSizeFromOrigToEnc(local.size);
    }

    if (local.keyEnc === undefined || local.keyEnc === "") {
      let keyEnc = this.cacheMapOrigToEnc[input.key];
      if (keyEnc !== undefined && keyEnc !== "" && keyEnc !== local.key) {
        // reuse remote encrypted key if any
        local.keyEnc = keyEnc;
      } else {
        // assign a new encrypted key
        keyEnc = await this._encryptName(input.key);
        local.keyEnc = keyEnc;
        // remember to add back to cache!
        this.cacheMapOrigToEnc[input.key] = keyEnc;
      }
    }

    // cache hit log
    log.debug(`[fsEncrypt] cache hit for key=${input.key}`);

    return local;
  }

  async _encryptContent(content: ArrayBuffer) {
    if (this.password === "") {
      return content;
    }
    if (this.method === "aes-256-gcm") {
      const res = await encryptArrayBuffer(content, this.password);
      if (res === undefined) {
        throw Error(`cannot encrypt content`);
      }
      return res;
    } else if (this.method === "rclone") {
      const res =
        await this.cipherRClone!.encryptContentByCallingWorker(content);
      if (res === undefined) {
        throw Error(`cannot encrypt content`);
      }
      return res;
    } else {
      throw Error(`not supported encrypt method=${this.method}`);
    }
  }

  async _decryptContent(content: ArrayBuffer) {
    if (this.password === "") {
      return content;
    }
    if (this.method === "aes-256-gcm") {
      const res = await decryptArrayBuffer(content, this.password);
      if (res === undefined) {
        throw Error(`cannot decrypt content`);
      }
      return res;
    } else if (this.method === "rclone") {
      const res =
        await this.cipherRClone!.decryptContentByCallingWorker(content);
      if (res === undefined) {
        throw Error(`cannot decrypt content`);
      }
      return res;
    } else {
      throw Error(`not supported decrypt method=${this.method}`);
    }
  }

  async _encryptName(name: string) {
    if (this.password === "") {
      return name;
    }
    if (this.method === "aes-256-gcm") {
      const res = await encryptStringToBase64url(name, this.password);
      if (res === undefined) {
        throw Error(`cannot encrypt name=${name}`);
      }
      return res;
    } else if (this.method === "rclone") {
      const res = await this.cipherRClone!.encryptNameByCallingWorker(name);
      if (res === undefined) {
        throw Error(`cannot encrypt name=${name}`);
      }
      return res;
    } else {
      throw Error(`not supported encrypt method=${this.method}`);
    }
  }

  async _decryptName(name: string): Promise<string> {
    if (this.password === "") {
      return name;
    }
    if (this.method === "aes-256-gcm") {
      try {
        const res = await decryptBase64urlToString(name, this.password);
        if (res !== undefined) {
          return res;
        } else {
          throw Error(`cannot decrypt name=${name}`);
        }
      } catch (error) {
        throw Error(`cannot decrypt name=${name}`);
      }
    } else if (this.method === "rclone") {
      const res = await this.cipherRClone!.decryptNameByCallingWorker(name);
      if (res === undefined) {
        throw Error(`cannot decrypt name=${name}`);
      }
      return res;
    } else {
      throw Error(`not supported decrypt method=${this.method}`);
    }
  }

  _getSizeFromOrigToEnc(x: number) {
    if (this.password === "") {
      return x;
    }
    if (this.method === "aes-256-gcm") {
      return getSizeFromOrigToEnc(x);
    } else if (this.method === "rclone") {
      return rclone.getSizeFromOrigToEnc(x);
    } else {
      throw Error(`not supported encrypt method=${this.method}`);
    }
  }

  async getUserDisplayName(): Promise<string> {
    return await this.innerFs.getUserDisplayName();
  }

  async revokeAuth(): Promise<any> {
    return await this.innerFs.revokeAuth();
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
