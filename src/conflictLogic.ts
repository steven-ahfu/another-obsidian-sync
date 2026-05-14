import isEqual from "lodash/isEqual";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LCS, mergeDigIn } = require("node-diff3") as typeof import("node-diff3/src/diff3");
import type { Entity } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { log } from "./moreOnLog";

const MERGABLE_SIZE = 1 * 1024 * 1024; // 1MB

export function isMergable(a: Entity, b?: Entity) {
  if (b !== undefined && a.key !== b.key) {
    const result = false;
    const reason = "keys differ";
    log.debug(
      `[conflictLogic] isMergable: key=${a.key} result=${result} reason=${reason}`
    );
    return result;
  }

  const result =
    !a.key!.endsWith("/") &&
    (a.size ?? 0) <= MERGABLE_SIZE &&
    (a.key!.endsWith(".md") || a.key!.endsWith(".markdown"));

  const reason = !a.key!.endsWith("/")
    ? (a.size ?? 0) <= MERGABLE_SIZE
      ? a.key!.endsWith(".md") || a.key!.endsWith(".markdown")
        ? "ok"
        : "not markdown"
      : "too large"
    : "is folder";

  log.debug(
    `[conflictLogic] isMergable: key=${a.key} result=${result} reason=${reason}`
  );
  return result;
}

/**
 * slightly modify to adjust in markdown context
 */
function mergeDigInModified(a: string, o: string, b: string) {
  const { conflict, result } = mergeDigIn(a, o, b, {
    stringSeparator: /\n/,
  });
  for (let index = 0; index < result.length; ++index) {
    if (["<<<<<<<", "=======", ">>>>>>>"].includes(result[index])) {
      result[index] = "`" + result[index] + "`";
    }
  }
  return {
    conflict,
    result,
  };
}

function getLCSText(a: string, b: string) {
  const aa = a.split("\n");
  const bb = b.split("\n");
  let raw = LCS(aa, bb);

  const k: string[] = [];

  do {
    k.unshift(aa[raw.buffer1index]);

    raw = raw.chain as any;
  } while (raw !== null && raw !== undefined && raw.buffer1index !== -1);

  return k.join("\n");
}

/**
 * It's tricky. We find LCS then pretend it's the original text
 */
export function twoWayMerge(a: string, b: string): string {
  const aa = a.trim();
  const bb = b.trim();
  if (aa === "" && bb === "") {
    return aa.length >= bb.length ? a : b;
  }
  if (bb === "") {
    return a;
  }
  if (aa === "") {
    return b;
  }

  const c = getLCSText(a, b);
  const d = mergeDigInModified(a, c, b).result.join("\n");
  return d;
}

/**
 * Originally three way merge.
 */
export function threeWayMerge(a: string, b: string, orig: string) {
  return mergeDigInModified(a, orig, b).result.join("\n");
}

export async function mergeFile(
  key: string,
  left: FakeFs,
  right: FakeFs,
  contentOrig: ArrayBuffer | null | undefined
) {
  log.debug(`[conflictLogic] mergeFile: attempting merge for key=${key}`);

  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in mergeFile`);
  }

  if (!key.endsWith(".md") && !key.endsWith(".markdown")) {
    throw Error(`currently only support markdown files in mergeFile`);
  }

  const [contentLeft, contentRight] = await Promise.all([
    left.readFile(key),
    right.readFile(key),
  ]);

  let newArrayBuffer: ArrayBuffer | undefined = undefined;
  const decoder = new TextDecoder("utf-8");

  if (isEqual(contentLeft, contentRight)) {
    // we are lucky enough
    newArrayBuffer = contentLeft;
  } else {
    if (contentOrig === null || contentOrig === undefined) {
      const newText = twoWayMerge(
        decoder.decode(contentLeft),
        decoder.decode(contentRight)
      );
      // no need to worry about the offset here because the array is new and not sliced
      newArrayBuffer = new TextEncoder().encode(newText).buffer;
    } else {
      const newText = threeWayMerge(
        decoder.decode(contentLeft),
        decoder.decode(contentRight),
        decoder.decode(contentOrig)
      );
      newArrayBuffer = new TextEncoder().encode(newText).buffer;
    }
  }

  const mtime = Date.now();

  // left (local) must wait for the right
  // because the mtime might be different after upload
  // upload firstly
  const rightEntity = await right.writeFile(key, newArrayBuffer, mtime, mtime);
  // write local secondly
  const leftEntity = await left.writeFile(
    key,
    newArrayBuffer,
    rightEntity.mtimeCli ?? mtime,
    rightEntity.ctimeCli ?? rightEntity.mtimeCli ?? mtime
  );

  log.debug(`[conflictLogic] mergeFile: merge complete for key=${key}`);

  return {
    entity: rightEntity,
    content: newArrayBuffer,
  };
}

export function getFileRenameForDup(key: string) {
  if (
    key === "" ||
    key === "." ||
    key === ".." ||
    key === "/" ||
    key.endsWith("/")
  ) {
    throw Error(`we cannot rename key=${key}`);
  }

  const segsPath = key.split("/");
  const name = segsPath[segsPath.length - 1];
  const segsName = name.split(".");

  if (segsName.length === 0) {
    throw Error(`we cannot rename key=${key}`);
  } else if (segsName.length === 1) {
    // name = "kkk" without any dot
    segsPath[segsPath.length - 1] = `${name}.dup`;
  } else if (segsName.length === 2) {
    if (segsName[0] === "") {
      // name = ".kkkk" with leading dot
      segsPath[segsPath.length - 1] = `${name}.dup`;
    } else if (segsName[1] === "") {
      // name = "kkkk." with tailing dot
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup`;
    } else {
      // name = "aaa.bbb" normally
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup.${segsName[1]}`;
    }
  } else {
    // name = "[...].bbb.ccc"
    const firstPart = segsName.slice(0, segsName.length - 1).join(".");
    const thirdPart = segsName[segsName.length - 1];
    segsPath[segsPath.length - 1] = `${firstPart}.dup.${thirdPart}`;
  }
  const res = segsPath.join("/");
  return res;
}

function arraysAreEqual(arr1: ArrayBuffer, arr2: ArrayBuffer) {
  if (arr1.byteLength !== arr2.byteLength) {
    return false;
  }
  const u1 = new Uint8Array(arr1);
  const u2 = new Uint8Array(arr2);

  for (let i = 0; i < u1.byteLength; ++i) {
    if (u1[i] !== u2[i]) {
      return false;
    }
  }

  return true;
}

async function copyFile(key: string, left: FakeFs, right: FakeFs) {
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFile`);
  }
  const statsLeft = await left.stat(key);
  const content = await left.readFile(key);

  if (statsLeft.size === undefined || statsLeft.size === 0) {
    statsLeft.size = content.byteLength;
  } else {
    if (statsLeft.size !== content.byteLength) {
      throw Error(
        `error copying ${left.serviceType}=>${right.serviceType}: size not matched`
      );
    }
  }

  if (statsLeft.mtimeCli === undefined) {
    throw Error(`error copying ${left.serviceType}=>${right.serviceType}, no mtimeCli`);
  }

  return {
    entity: await right.writeFile(
      key,
      content,
      statsLeft.mtimeCli,
      statsLeft.ctimeCli ?? statsLeft.mtimeCli
    ),
    content: content,
  };
}

/**
 * 1. download remote
 * 2. compare
 * 3. if the same, update local but not upload
 * 4. if not the same, rename local and save remote
 */
async function tryDuplicateFileForSameSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  // 1. download
  const remoteContent = await fsRemote.readFile(key);

  // 2. compare
  const localContent = await fsLocal.readFile(key);
  const eq = arraysAreEqual(localContent, remoteContent);

  if (eq) {
    // 3. if the same, update local but not upload
    const entityRemote = await fsRemote.stat(key);

    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);
  } else {
    // 4. if not the same, rename local and save remote
    const nowMs = Date.now();
    await fsLocal.rename(key, key2, nowMs, nowMs);

    const entityRemote = await fsRemote.stat(key);
    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);

    const entityLocal = await fsLocal.stat(key2); // key2 here!
    const uploadResultEntity = await fsRemote.writeFile(
      key2, // key2 here!
      localContent,
      entityLocal.mtimeCli ?? Date.now(),
      entityLocal.ctimeCli ?? entityLocal.mtimeCli ?? Date.now()
    );
    await uploadCallback(uploadResultEntity);
  }
}

/**
 * local: x.md -> x.dup.md -> upload to remote
 * remote: x.md -> download to local -> using original name x.md
 */
async function tryDuplicateFileForDiffSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  const nowMs2 = Date.now();
  await fsLocal.rename(key, key2, nowMs2, nowMs2);

  /**
   * x.dup.md -> upload to remote
   */
  async function f1() {
    const k = await copyFile(key2, fsLocal, fsRemote);
    await uploadCallback(k.entity);
    return k.entity;
  }

  /**
   * x.md -> download to local
   */
  async function f2() {
    const k = await copyFile(key, fsRemote, fsLocal);
    await downloadCallback(k.entity);
    return k.entity;
  }

  const [resUpload, resDownload] = await Promise.all([f1(), f2()]);

  return {
    upload: resUpload,
    download: resDownload,
  };
}

export async function tryDuplicateFile(
  key: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  log.debug(`[conflictLogic] tryDuplicateFile: creating dup for key=${key}`);

  let key2 = getFileRenameForDup(key);
  let usable = false;
  do {
    try {
      const s = await fsLocal.stat(key2);
      if (s === null || s === undefined) {
        throw Error(`not exist $${key2}`);
      }
      key2 = getFileRenameForDup(key2);
    } catch (e) {
      // not exists, exactly what we want
      usable = true;
    }
  } while (!usable);

  const localSize = await fsLocal.stat(key);
  const remoteSize = await fsRemote.stat(key);

  if (
    localSize !== undefined &&
    remoteSize !== undefined &&
    localSize.size === remoteSize.size
  ) {
    return await tryDuplicateFileForSameSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  } else {
    return await tryDuplicateFileForDiffSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  }
}
