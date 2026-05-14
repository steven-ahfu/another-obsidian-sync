import { expect } from "chai";

describe("FakeFsS3", () => {
  it("DEFAULT_S3_CONFIG has forcePathStyle true", async () => {
    const { DEFAULT_S3_CONFIG } = await import("../src/fsS3");
    expect(DEFAULT_S3_CONFIG.forcePathStyle).to.be.true;
  });

  it("FakeFsS3 constructs without throwing", async () => {
    const { FakeFsS3, DEFAULT_S3_CONFIG } = await import("../src/fsS3");
    const cfg = {
      ...DEFAULT_S3_CONFIG,
      s3Endpoint: "http://localhost:9000",
      s3Region: "us-east-1",
      s3AccessKeyID: "minioadmin",
      s3SecretAccessKey: "minioadmin",
      s3BucketName: "test-bucket",
    };
    expect(() => new FakeFsS3(cfg, "my-vault", false)).to.not.throw();
  });

  it("serviceType is s3", async () => {
    const { FakeFsS3, DEFAULT_S3_CONFIG } = await import("../src/fsS3");
    const fs = new FakeFsS3({ ...DEFAULT_S3_CONFIG, s3BucketName: "b" }, "vault", false);
    expect(fs.serviceType).to.equal("s3");
  });
});
