import { expect } from "chai";
import type { Entity } from "../src/baseTypes";

describe("isMergable", () => {
  it("returns true for small markdown file", async () => {
    const { isMergable } = await import("../src/conflictLogic");
    const e: Entity = { key: "note.md", size: 1000 };
    expect(isMergable(e)).to.be.true;
  });

  it("returns false for non-markdown file", async () => {
    const { isMergable } = await import("../src/conflictLogic");
    const e: Entity = { key: "image.png", size: 100 };
    expect(isMergable(e)).to.be.false;
  });

  it("returns false for file over 1MB", async () => {
    const { isMergable } = await import("../src/conflictLogic");
    const e: Entity = { key: "big.md", size: 2 * 1024 * 1024 };
    expect(isMergable(e)).to.be.false;
  });

  it("returns false for folder", async () => {
    const { isMergable } = await import("../src/conflictLogic");
    const e: Entity = { key: "folder/", size: 0, synthesizedFolder: true };
    expect(isMergable(e)).to.be.false;
  });
});

describe("twoWayMerge", () => {
  it("returns original when both sides identical", async () => {
    const { twoWayMerge } = await import("../src/conflictLogic");
    const text = "line1\nline2\nline3";
    const result = twoWayMerge(text, text);
    expect(result).to.equal(text);
  });

  it("merges non-conflicting additions", async () => {
    const { twoWayMerge } = await import("../src/conflictLogic");
    const a = "line1\nline2\nlineA";
    const b = "line1\nline2\nlineB";
    const result = twoWayMerge(a, b);
    expect(result).to.include("lineA");
    expect(result).to.include("lineB");
  });
});
