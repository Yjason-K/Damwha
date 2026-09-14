import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  embeddedDatabaseUrl,
  pgBinaries,
  pgLayout,
  pgToolEnv,
  PG_BINARY_NAMES,
  SOCKET_PATH_MAX_BYTES,
  socketPathTooLong,
} from "../src/services/pg-layout";

const UD = "/Users/someone/Library/Application Support/Damwha";

describe("pgLayout", () => {
  it("pairs the cluster and the storage under data/ and keeps the Phase 1·2 storage out of it", () => {
    const l = pgLayout(UD);
    expect(l.pgdata).toBe(path.join(UD, "data", "postgres"));
    expect(l.storage).toBe(path.join(UD, "data", "storage"));
    expect(l.marker).toBe(path.join(UD, "data", "storage", ".damwha-cluster"));
    expect(l.socketFile).toBe(path.join(UD, "run", ".s.PGSQL.5432"));
    expect(l.backups).toBe(path.join(UD, "backups"));
    expect(l.logDir).toBe(path.join(UD, "logs", "postgres"));
    // Phase 1·2가 Docker DB와 쓴 <userData>/storage는 이 배치의 어느 경로와도 같지 않다 (스펙 §6.2).
    expect(Object.values(l)).not.toContain(path.join(UD, "storage"));
  });
});

describe("socketPathTooLong", () => {
  it("accepts this machine's path (72 bytes)", () => {
    expect(socketPathTooLong(pgLayout("/Users/gim-yeongjae/Library/Application Support/Damwha"))).toBeNull();
  });

  it("measures bytes, not characters, and draws the line at 103", () => {
    const tail = "/run/.s.PGSQL.5432".length;
    const at = (bytes: number) => "/" + "a".repeat(bytes - tail - 1);
    expect(socketPathTooLong(pgLayout(at(SOCKET_PATH_MAX_BYTES)))).toBeNull();
    expect(socketPathTooLong(pgLayout(at(SOCKET_PATH_MAX_BYTES + 1)))).toBe(SOCKET_PATH_MAX_BYTES + 1);
    // 한글 한 글자는 UTF-8 3바이트다. 이 경로는 49글자지만 109바이트라, 글자 수로 세면 통과시킨다.
    const korean = pgLayout("/" + "가".repeat(30));
    expect(korean.socketFile.length).toBeLessThan(SOCKET_PATH_MAX_BYTES);
    expect(socketPathTooLong(korean)).toBe(Buffer.byteLength(korean.socketFile, "utf8"));
  });
});

describe("embeddedDatabaseUrl", () => {
  it("names the socket directory as host so no client can fall back to TCP localhost:5432", () => {
    const l = pgLayout(UD);
    const raw = embeddedDatabaseUrl(l);
    // WHATWG URL 표준은 userinfo("user@")가 있으면 host를 비워 두는 것을 파싱 실패로 정의한다(RFC 스펙,
    // Node 22에서 `new URL("postgresql://damwha@/damwha")`가 곧장 Invalid URL을 던지는 것으로 확인) —
    // 바로 이 값 그대로다. node-postgres가 쓰는 pg-connection-string도 같은 문제로 "@/"를 더미 호스트로
    // 바꿔치기한 뒤 다시 판다(node_modules/pg-connection-string/index.js). 여기서도 같은 방식으로 검증한다:
    // 더미 호스트로 바꾼 뒤에도 값이 맞으면, 원래 문자열의 host 자리는 정말 비어 있었다는 뜻이다.
    const url = new URL(raw.replace("@/", "@dummy-host/"));
    expect(url.username).toBe("damwha");
    expect(url.hostname).toBe("dummy-host");
    expect(url.pathname).toBe("/damwha");
    expect(url.searchParams.get("host")).toBe(l.runDir);
    expect(raw).toContain("Application%20Support");
  });
});

describe("pgBinaries / pgToolEnv", () => {
  it("points every tool the adapter calls into the bundle's bin/", () => {
    const b = pgBinaries("/B/postgres");
    expect(b.postgres).toBe("/B/postgres/bin/postgres");
    expect(b.pgControldata).toBe("/B/postgres/bin/pg_controldata");
    expect(PG_BINARY_NAMES).toEqual(["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"]);
  });

  it("pins the locale so label parsing does not depend on the build's NLS option", () => {
    expect(pgToolEnv()).toMatchObject({ LC_ALL: "C", LANG: "C" });
  });
});
