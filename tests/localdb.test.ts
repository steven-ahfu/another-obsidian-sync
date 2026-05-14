import { expect } from "chai";

describe("localdb", () => {
  it("exports DB_SCHEMA_VERSION constant", async () => {
    const mod = await import("../src/localdb");
    expect(mod.DB_SCHEMA_VERSION).to.be.a("string");
  });

  it("exports upsertPrevSyncRecordByVaultAndProfile", async () => {
    const mod = await import("../src/localdb");
    expect(mod.upsertPrevSyncRecordByVaultAndProfile).to.be.a("function");
  });

  it("exports getAllPrevSyncRecordsByVaultAndProfile", async () => {
    const mod = await import("../src/localdb");
    expect(mod.getAllPrevSyncRecordsByVaultAndProfile).to.be.a("function");
  });

  it("exports clearPrevSyncRecordByVaultAndProfile", async () => {
    const mod = await import("../src/localdb");
    expect(mod.clearPrevSyncRecordByVaultAndProfile).to.be.a("function");
  });
});
