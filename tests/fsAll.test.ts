import { expect } from "chai";

describe("FakeFs interface contract", () => {
  it("should have all required abstract method names defined in prototype chain", async () => {
    const { FakeFs } = await import("../src/fsAll");
    // Verify the abstract class exists and has the non-abstract methods
    expect(FakeFs).to.be.a("function");
    expect(FakeFs.prototype.getUserDisplayName).to.be.a("function");
    expect(FakeFs.prototype.revokeAuth).to.be.a("function");
    expect(FakeFs.prototype.allowEmptyFile).to.be.a("function");
  });

  it("allowEmptyFile returns true by default", async () => {
    const { FakeFs } = await import("../src/fsAll");
    // Create a concrete subclass to test the concrete method
    class TestFs extends FakeFs {
      readonly serviceType = "s3" as const;
      async walk(): Promise<any[]> { return []; }
      async walkPartial(): Promise<any[]> { return []; }
      async stat(key: string): Promise<any> { return { key }; }
      async mkdir(key: string): Promise<any> { return { key }; }
      async writeFile(key: string, content: ArrayBuffer): Promise<any> { return { key }; }
      async readFile(key: string): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
      async rename(k1: string, k2: string, mtime: number, ctime: number): Promise<void> {}
      async rm(key: string): Promise<void> {}
    }
    const fs = new TestFs();
    expect(fs.allowEmptyFile()).to.be.true;
  });
});
