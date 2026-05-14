import {
  Cipher as CipherRCloneCryptPack,
  encryptedSize,
} from "@fyears/rclone-crypt";

// @ts-ignore
import EncryptWorker from "./encryptRClone.worker";

import { log } from "./moreOnLog";

interface RecvMsg {
  status: "ok" | "error";
  outputName?: string;
  outputContent?: ArrayBuffer;
  error?: any;
}

export const getSizeFromOrigToEnc = encryptedSize;

export class CipherRclone {
  readonly password: string;
  readonly cipher: CipherRCloneCryptPack;
  readonly workers: Worker[];
  init: boolean;
  workerIdx: number;
  constructor(password: string, workerNum: number) {
    this.password = password;
    this.init = false;
    this.workerIdx = 0;

    // console.debug("begin creating CipherRCloneCryptPack");
    this.cipher = new CipherRCloneCryptPack("base64");
    // console.debug("finish creating CipherRCloneCryptPack");

    log.debug(`[encryptRClone] initializing pool with ${workerNum} workers`);
    this.workers = [];
    for (let i = 0; i < workerNum; ++i) {
      this.workers.push(new (EncryptWorker as any)() as Worker);
    }
  }

  closeResources() {
    log.debug(`[encryptRClone] closeResources: terminating ${this.workers.length} workers`);
    for (let i = 0; i < this.workers.length; ++i) {
      this.workers[i].terminate();
    }
  }

  async prepareByCallingWorker(): Promise<void> {
    if (this.init) {
      return;
    }
    // console.debug("begin prepareByCallingWorker");
    await this.cipher.key(this.password, "");
    // console.debug("finish getting key");

    const res: Promise<void>[] = [];
    for (let i = 0; i < this.workers.length; ++i) {
      res.push(
        new Promise((resolve, reject) => {
          const channel = new MessageChannel();

          channel.port2.onmessage = (event) => {
            const msg = event.data as RecvMsg;
            const { status } = msg;
            log.debug(`[encryptRClone] received status=${msg.status} for action=prepare`);
            if (status === "ok") {
              this.init = true;
              resolve(); // return the class object itself
            } else {
              reject("error after prepareByCallingWorker");
            }
          };

          channel.port2.onmessageerror = (event) => {
            reject(event);
          };

          log.debug(`[encryptRClone] sending action=prepare to worker`);
          this.workers[i].postMessage(
            {
              action: "prepare",
              dataKeyBuf: this.cipher.dataKey.buffer,
              nameKeyBuf: this.cipher.nameKey.buffer,
              nameTweakBuf: this.cipher.nameTweak.buffer,
            },
            [channel.port1 /* buffer no transfered because we need to copy */]
          );
        })
      );
    }
    await Promise.all(res);
  }

  async encryptNameByCallingWorker(inputName: string): Promise<string> {
    // console.debug("main: start encryptNameByCallingWorker");
    await this.prepareByCallingWorker();
    // console.debug(
    //   "main: really start generate promise in encryptNameByCallingWorker"
    // );
    ++this.workerIdx;
    const whichWorker = this.workerIdx % this.workers.length;
    return await new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      channel.port2.onmessage = (event) => {
        const msg = event.data as RecvMsg;
        log.debug(`[encryptRClone] received status=${msg.status} for action=encryptName`);
        const { outputName } = msg;
        if (outputName === undefined) {
          reject("unknown outputName after encryptNameByCallingWorker");
        } else {
          resolve(outputName);
        }
      };

      channel.port2.onmessageerror = (event) => {
        reject(event);
      };

      log.debug(`[encryptRClone] sending action=encryptName to worker`);
      this.workers[whichWorker].postMessage(
        {
          action: "encryptName",
          inputName: inputName,
        },
        [channel.port1]
      );
    });
  }

  async decryptNameByCallingWorker(inputName: string): Promise<string> {
    await this.prepareByCallingWorker();
    ++this.workerIdx;
    const whichWorker = this.workerIdx % this.workers.length;
    return await new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      channel.port2.onmessage = (event) => {
        const msg = event.data as RecvMsg;
        log.debug(`[encryptRClone] received status=${msg.status} for action=decryptName`);
        const { outputName, status } = msg;

        if (status === "error") {
          reject("error");
        } else {
          if (outputName === undefined) {
            reject("unknown outputName after decryptNameByCallingWorker");
          } else {
            resolve(outputName);
          }
        }
      };

      channel.port2.onmessageerror = (event) => {
        reject(event);
        channel;
      };

      log.debug(`[encryptRClone] sending action=decryptName to worker`);
      this.workers[whichWorker].postMessage(
        {
          action: "decryptName",
          inputName: inputName,
        },
        [channel.port1]
      );
    });
  }

  async encryptContentByCallingWorker(
    input: ArrayBuffer
  ): Promise<ArrayBuffer> {
    await this.prepareByCallingWorker();
    ++this.workerIdx;
    const whichWorker = this.workerIdx % this.workers.length;
    return await new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      channel.port2.onmessage = (event) => {
        const msg = event.data as RecvMsg;
        log.debug(`[encryptRClone] received status=${msg.status} for action=encryptContent`);
        const { outputContent } = msg;
        if (outputContent === undefined) {
          reject("unknown outputContent after encryptContentByCallingWorker");
        } else {
          resolve(outputContent);
        }
      };

      channel.port2.onmessageerror = (event) => {
        reject(event);
      };

      log.debug(`[encryptRClone] sending action=encryptContent to worker`);
      this.workers[whichWorker].postMessage(
        {
          action: "encryptContent",
          inputContent: input,
        },
        [
          channel.port1,
          // input // the array buffer might be re-used later, so we CANNOT transfer here
        ]
      );
    });
  }

  async decryptContentByCallingWorker(
    input: ArrayBuffer
  ): Promise<ArrayBuffer> {
    await this.prepareByCallingWorker();
    ++this.workerIdx;
    const whichWorker = this.workerIdx % this.workers.length;
    return await new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      channel.port2.onmessage = (event) => {
        const msg = event.data as RecvMsg;
        log.debug(`[encryptRClone] received status=${msg.status} for action=decryptContent`);
        const { outputContent, status } = msg;

        if (status === "error") {
          reject("error");
        } else {
          if (outputContent === undefined) {
            reject("unknown outputContent after decryptContentByCallingWorker");
          } else {
            resolve(outputContent);
          }
        }
      };

      channel.port2.onmessageerror = (event) => {
        reject(event);
      };

      log.debug(`[encryptRClone] sending action=decryptContent to worker`);
      this.workers[whichWorker].postMessage(
        {
          action: "decryptContent",
          inputContent: input,
        },
        [
          channel.port1,
          input, // not transfer for safety
        ]
      );
    });
  }
}
