import { expect } from "chai";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");

// Intercept the worker module import so it doesn't execute browser-only code
// (i.e., referencing `self` as WorkerGlobalScope) when running under ts-node.
// We restore the original loader immediately after the encryptRClone module is
// cached so that subsequent test files are not affected.
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("encryptRClone.worker")) {
    // Return a dummy constructor that acts as a no-op Worker
    return function DummyWorker() {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

describe("CipherRclone", () => {
  after(() => {
    // Restore the original module loader once these tests finish
    (Module as any)._load = originalLoad;
  });

  it("should export CipherRclone class", async () => {
    const mod = await import("../src/encryptRClone");
    expect(mod.CipherRclone).to.be.a("function");
  });

  it("should have expected methods on prototype", async () => {
    const { CipherRclone } = await import("../src/encryptRClone");
    const proto = CipherRclone.prototype;
    expect(proto.prepareByCallingWorker).to.be.a("function");
    expect(proto.encryptNameByCallingWorker).to.be.a("function");
    expect(proto.decryptNameByCallingWorker).to.be.a("function");
    expect(proto.encryptContentByCallingWorker).to.be.a("function");
    expect(proto.decryptContentByCallingWorker).to.be.a("function");
    expect(proto.closeResources).to.be.a("function");
  });
});
