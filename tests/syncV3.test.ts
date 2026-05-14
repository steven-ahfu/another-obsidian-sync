import { expect } from "chai";

// Intercept ESM-only modules that can't be require()'d in CommonJS test env
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "p-queue") {
    // Return a minimal PQueue stub
    return {
      default: class PQueue {
        add(fn: () => any) { return fn(); }
        onIdle() { return Promise.resolve(); }
      }
    };
  }
  if (request === "xregexp") {
    // Return a minimal XRegExp stub
    const xregexp = (pattern: string, flags?: string) => {
      try { return new RegExp(pattern, flags); } catch { return /(?!)/; }
    };
    xregexp.default = xregexp;
    return xregexp;
  }
  return originalLoad.call(this, request, parent, isMain);
};

describe("syncV3", () => {
  after(() => {
    (Module as any)._load = originalLoad;
  });

  it("exports checkIsSkipItemOrNotByName function", async () => {
    const mod = await import("../src/syncV3");
    expect(mod.checkIsSkipItemOrNotByName).to.be.a("function");
  });

  it("does not skip a normal file", async () => {
    const { checkIsSkipItemOrNotByName } = await import("../src/syncV3");
    // args: key, syncConfigDir, syncBookmarks, syncUnderscoreItems, configDir, ignorePaths, onlyAllowPaths
    const result = checkIsSkipItemOrNotByName("note.md", false, false, true, ".obsidian", [], []);
    expect(result.finalIsIgnored).to.be.false;
  });

  it("skips hidden files when syncConfigDir is false", async () => {
    const { checkIsSkipItemOrNotByName } = await import("../src/syncV3");
    const result = checkIsSkipItemOrNotByName(".hidden.md", false, false, true, ".obsidian", [], []);
    expect(result.finalIsIgnored).to.be.true;
  });

  it("exports syncer function", async () => {
    const mod = await import("../src/syncV3");
    expect(mod.syncer).to.be.a("function");
  });
});
