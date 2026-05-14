import isEqual from "lodash/isEqual";
import { nanoid } from "nanoid";
import type { Entity, SUPPORTED_SERVICES_TYPE_V3 } from "./baseTypes";

export abstract class FakeFs {
  abstract readonly serviceType: SUPPORTED_SERVICES_TYPE_V3 | "encrypt";

  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity>;
  abstract readFile(key: string): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string, mtime: number, ctime: number): Promise<void>;
  abstract rm(key: string): Promise<void>;

  async checkConnectCommonOps(callbackFunc?: any): Promise<boolean> {
    try {
      const folderName = `rs-test-folder-${nanoid()}/`;
      await this.mkdir(folderName);

      const filename = `${folderName}rs-test-file-${nanoid()}`;
      const ctime = Date.now();
      const mtime1 = Date.now();
      const content1 = new ArrayBuffer(100);
      await this.writeFile(filename, content1, mtime1, ctime);

      const mtime2 = Date.now();
      const content2 = new ArrayBuffer(200);
      await this.writeFile(filename, content2, mtime2, ctime);

      const content3 = await this.readFile(filename);
      if (!isEqual(content2, content3)) {
        throw Error(`downloaded file is not equal with uploaded file!`);
      }

      await this.rm(filename);
      await this.rm(folderName);

      return true;
    } catch (err) {
      console.error(err);
      callbackFunc?.(err);
      return false;
    }
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("not implemented");
  }

  async revokeAuth(): Promise<any> {
    throw new Error("not implemented");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
