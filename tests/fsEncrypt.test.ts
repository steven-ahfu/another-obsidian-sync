import { expect } from "chai";
import { FakeFs } from "../src/fsAll";
import type { Entity } from "../src/baseTypes";

// Intercept ESM-only modules that can't be require()'d in CommonJS test env
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("encryptRClone.worker")) {
    return function DummyWorker() {};
  }
  if (request.includes("@fyears/rclone-crypt")) {
    return { Cipher: function () {}, encryptedSize: (x: number) => x + 32 };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// In-memory FakeFs for testing
class MemFs extends FakeFs {
  readonly serviceType = "s3" as const;
  store: Record<string, ArrayBuffer> = {};

  async walk(): Promise<Entity[]> {
    return Object.keys(this.store).map(key => ({ key, size: this.store[key].byteLength }));
  }
  async walkPartial() { return this.walk(); }
  async stat(key: string): Promise<Entity> { return { key, size: this.store[key]?.byteLength ?? 0 }; }
  async mkdir(key: string): Promise<Entity> { return { key, size: 0, synthesizedFolder: true }; }
  async writeFile(key: string, content: ArrayBuffer, _m: number, _c: number): Promise<Entity> {
    this.store[key] = content;
    return { key, size: content.byteLength };
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    if (!this.store[key]) throw new Error(`not found: ${key}`);
    return this.store[key];
  }
  async rename(k1: string, k2: string, _m: number, _c: number): Promise<void> {
    this.store[k2] = this.store[k1];
    delete this.store[k1];
  }
  async rm(key: string): Promise<void> { delete this.store[key]; }
}

describe("FakeFsEncrypt", () => {
  after(() => {
    (Module as any)._load = originalLoad;
  });

  beforeEach(function () {
    global.window = {
      crypto: require("crypto").webcrypto,
    } as any;
  });

  it("exports FakeFsEncrypt class", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    expect(FakeFsEncrypt).to.be.a("function");
  });

  it("isPasswordEmpty returns true when no password", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    const enc = new FakeFsEncrypt(new MemFs(), "", "aes-256-gcm");
    expect(enc.isPasswordEmpty()).to.be.true;
  });

  it("isPasswordEmpty returns false when password set", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    const enc = new FakeFsEncrypt(new MemFs(), "secret", "aes-256-gcm");
    expect(enc.isPasswordEmpty()).to.be.false;
  });

  it("AES-GCM: writeFile+readFile round-trip decrypts correctly", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    const inner = new MemFs();
    const enc = new FakeFsEncrypt(inner, "testpass", "aes-256-gcm");

    // Build cache map first (required before writeFile/readFile)
    await enc.walk();

    const original = new TextEncoder().encode("hello encrypted world").buffer as ArrayBuffer;
    await enc.writeFile("note.md", original, Date.now(), Date.now());

    // The inner store should have an encrypted key (not "note.md")
    const keys = Object.keys(inner.store);
    expect(keys.length).to.equal(1);

    const decrypted = await enc.readFile("note.md");
    expect(new TextDecoder().decode(decrypted)).to.equal("hello encrypted world");
  });

  it("passes through unencrypted when password is empty", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    const inner = new MemFs();
    const enc = new FakeFsEncrypt(inner, "", "aes-256-gcm");

    // Build cache map first
    await enc.walk();

    const original = new TextEncoder().encode("plain").buffer as ArrayBuffer;
    await enc.writeFile("plain.md", original, Date.now(), Date.now());

    // Key should be stored as-is when no password
    expect(inner.store["plain.md"]).to.exist;
    const result = await enc.readFile("plain.md");
    expect(new TextDecoder().decode(result)).to.equal("plain");
  });

  it("serviceType is 'encrypt'", async () => {
    const { FakeFsEncrypt } = await import("../src/fsEncrypt");
    const enc = new FakeFsEncrypt(new MemFs(), "pw", "aes-256-gcm");
    expect(enc.serviceType).to.equal("encrypt");
  });
});
