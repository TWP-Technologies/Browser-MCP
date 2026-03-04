import { describe, expect, test } from "bun:test";
import { assert_release_version_sync, normalize_release_version } from "../../scripts/check_release_version_sync";

describe("normalize_release_version", () => {
  test("accepts versions with or without v prefix", () => {
    expect(normalize_release_version("v1.2.3")).toBe("1.2.3");
    expect(normalize_release_version("1.2.3")).toBe("1.2.3");
  });

  test("accepts semver prerelease and build suffixes", () => {
    expect(normalize_release_version("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(normalize_release_version("1.2.3+build.9")).toBe("1.2.3+build.9");
  });

  test("rejects invalid version strings", () => {
    expect(() => normalize_release_version("1.2")).toThrow(/semantic-looking/i);
    expect(() => normalize_release_version("version-1.2.3")).toThrow(/semantic-looking/i);
  });
});

describe("assert_release_version_sync", () => {
  test("passes when package and manifest match without explicit release", () => {
    expect(() =>
      assert_release_version_sync({
        package_version: "0.1.0",
        manifest_version: "0.1.0",
      }),
    ).not.toThrow();
  });

  test("fails when package and manifest mismatch", () => {
    expect(() =>
      assert_release_version_sync({
        package_version: "0.1.0",
        manifest_version: "0.1.1",
      }),
    ).toThrow(/package\.json=0\.1\.0 manifest\.json=0\.1\.1/i);
  });

  test("fails when release does not match package and manifest", () => {
    expect(() =>
      assert_release_version_sync({
        package_version: "0.1.0",
        manifest_version: "0.1.0",
        release_version: "0.2.0",
      }),
    ).toThrow(/release=0\.2\.0 package\.json=0\.1\.0 manifest\.json=0\.1\.0/i);
  });
});
