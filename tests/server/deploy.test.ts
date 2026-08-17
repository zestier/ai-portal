import { beforeEach, describe, expect, it, vi } from "vitest";

describe("deploy metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.ZAP_DEPLOYED_AT;
  });

  it("returns the process start time outside the serve supervisor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-05-23T05:12:34.567Z"),
    );
    vi.spyOn(process, "uptime").mockReturnValue(120);
    const { getDeployMetadata } = await import("../../src/lib/server/deploy");

    expect(getDeployMetadata()).toEqual({
      deployedAt: "2026-05-23T05:10:34.567Z",
    });
  });

  it("normalizes the supervisor deploy timestamp once per process", async () => {
    process.env.ZAP_DEPLOYED_AT = "2026-05-23T05:12:34.567Z";
    const { getDeployMetadata } = await import("../../src/lib/server/deploy");

    process.env.ZAP_DEPLOYED_AT = "2026-05-23T06:12:34.567Z";

    expect(getDeployMetadata()).toEqual({
      deployedAt: "2026-05-23T05:12:34.567Z",
    });
  });

  it("falls back to process start time for invalid supervisor deploy timestamps", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-05-23T05:12:34.567Z"),
    );
    vi.spyOn(process, "uptime").mockReturnValue(120);
    process.env.ZAP_DEPLOYED_AT = "not-a-date";
    const { getDeployMetadata } = await import("../../src/lib/server/deploy");

    expect(getDeployMetadata()).toEqual({
      deployedAt: "2026-05-23T05:10:34.567Z",
    });
  });
});
