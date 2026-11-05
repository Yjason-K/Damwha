import { describe, expect, it } from "vitest";
import { assertReleaseBuildInfo, provenanceFor } from "../../scripts/lib/release-provenance.mjs";

const COMMIT = "4bac4a894db81c58e27b0a05812c9921d505b31b";

describe("assertReleaseBuildInfo", () => {
  it("같은 버전·같은 커밋의 깨끗한 빌드는 통과한다", () => {
    expect(() => assertReleaseBuildInfo({ version: "0.4.6", commit: COMMIT.slice(0, 12) }, { version: "0.4.6", commit: COMMIT })).not.toThrow();
  });
  it("dirty 빌드는 같은 커밋이어도 던진다", () => {
    expect(() =>
      assertReleaseBuildInfo({ version: "0.4.6", commit: `${COMMIT.slice(0, 12)}-dirty` }, { version: "0.4.6", commit: COMMIT }),
    ).toThrow(/dirty/);
  });
  it("다른 커밋의 빌드는 던진다", () => {
    expect(() => assertReleaseBuildInfo({ version: "0.4.6", commit: "0123456789ab" }, { version: "0.4.6", commit: COMMIT })).toThrow(
      /0123456789ab/,
    );
  });
  it("버전이 다르면 던진다", () => {
    expect(() => assertReleaseBuildInfo({ version: "0.4.5", commit: COMMIT.slice(0, 12) }, { version: "0.4.6", commit: COMMIT })).toThrow(
      /0\.4\.5/,
    );
  });
  it("build-info가 없으면 던진다", () => {
    expect(() => assertReleaseBuildInfo(null, { version: "0.4.6", commit: COMMIT })).toThrow();
  });
});

describe("provenanceFor", () => {
  it("v<version> 태그와 전체 커밋·해시를 담는다", () => {
    expect(provenanceFor({ version: "0.4.6", commit: COMMIT, dmg: "Damwha-0.4.6-arm64.dmg", sha256: "ab" })).toEqual({
      version: "0.4.6",
      tag: "v0.4.6",
      commit: COMMIT,
      dmg: "Damwha-0.4.6-arm64.dmg",
      sha256: "ab",
    });
  });
});
