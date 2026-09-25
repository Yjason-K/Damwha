import * as path from "path";

/**
 * 내장 PostgreSQL의 배치와 접속 (Phase 3 스펙 §6.1·§6.3). electron을 import하지 않는 순수 모듈이다.
 *
 * dev와 packaged는 같은 userData를 쓴다(main.ts의 app.setName) — 그래서 이 배치도 하나이고 클러스터도 하나다.
 */

export const PG_MAJOR = "16";
/** 소켓 파일 이름(.s.PGSQL.5432)에만 쓰인다. TCP는 열지 않는다. */
export const PG_SOCKET_PORT = 5432;
export const DB_NAME = "damwha";
/** 마이그레이션의 CREATE EXTENSION vector·pg_bigm이 슈퍼유저를 요구한다 — 둘 다 trusted extension이 아니다. */
export const DB_SUPERUSER = "damwha";
/** macOS sun_path는 104바이트이고 NUL이 한 자리를 쓴다. */
export const SOCKET_PATH_MAX_BYTES = 103;

export interface PgLayout {
  userData: string;
  /** 클러스터와 스토리지의 "한 쌍"이 사는 곳. */
  dataDir: string;
  pgdata: string;
  storage: string;
  marker: string;
  runDir: string;
  socketFile: string;
  backups: string;
  /** logging_collector가 쓰는 디렉터리. 앱이 죽어도 서버가 계속 기록한다. */
  logDir: string;
  /** 판올림 스냅샷 (Phase 6b-2 스펙 §4). data/와 같은 볼륨의 형제다 — 안에 두면 clone과 교체의 경계가 꼬인다. */
  snapshots: string;
  /** 되돌리기 교체용 임시 clone (§6.3). */
  restoreStaging: string;
  /** 되돌리기 저널 (§6.2). */
  restoreJournal: string;
  /** 이 data/를 마지막으로 연 packaged 빌드 (§5.1). data/ **안**이라 되돌리기가 함께 되감는다. */
  generationFile: string;
}

export function pgLayout(userData: string): PgLayout {
  const dataDir = path.join(userData, "data");
  const runDir = path.join(userData, "run");
  return {
    userData,
    dataDir,
    pgdata: path.join(dataDir, "postgres"),
    storage: path.join(dataDir, "storage"),
    marker: path.join(dataDir, "storage", ".damwha-cluster"),
    runDir,
    socketFile: path.join(runDir, `.s.PGSQL.${PG_SOCKET_PORT}`),
    backups: path.join(userData, "backups"),
    logDir: path.join(userData, "logs", "postgres"),
    snapshots: path.join(userData, "snapshots"),
    restoreStaging: path.join(userData, "restore-staging"),
    restoreJournal: path.join(userData, "restore-journal.json"),
    generationFile: path.join(dataDir, ".damwha-generation"),
  };
}

/** 소켓 경로가 한도를 넘으면 그 바이트 수, 아니면 null. 폴백하지 않는다 — /tmp 류는 다른 사용자와 나누는 자리다. */
export function socketPathTooLong(layout: PgLayout): number | null {
  const bytes = Buffer.byteLength(layout.socketFile, "utf8");
  return bytes > SOCKET_PATH_MAX_BYTES ? bytes : null;
}

/**
 * API·worker·마이그레이션 러너가 받는 주소. host가 소켓 디렉터리라 어떤 소비자도 TCP localhost:5432(개발자의 Docker
 * DB)로 떨어지지 않는다 — node-pg는 host가 `/`로 시작하면 소켓에 붙고, libpq(psycopg)도 같다(2026-09-14 실측).
 * `Application Support`의 공백은 percent-encoding으로 싣는다.
 */
export function embeddedDatabaseUrl(layout: PgLayout): string {
  return `postgresql://${DB_SUPERUSER}@/${DB_NAME}?host=${encodeURIComponent(layout.runDir)}`;
}

export const PG_BINARY_NAMES = ["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"] as const;

export interface PgBinaries {
  /** 번들 루트 (그 아래 bin/·lib/·share/). */
  dir: string;
  postgres: string;
  initdb: string;
  pgControldata: string;
  createdb: string;
  psql: string;
  pgDump: string;
  pgRestore: string;
}

export function pgBinaries(bundleDir: string): PgBinaries {
  const bin = (name: (typeof PG_BINARY_NAMES)[number]) => path.join(bundleDir, "bin", name);
  return {
    dir: bundleDir,
    postgres: bin("postgres"),
    initdb: bin("initdb"),
    pgControldata: bin("pg_controldata"),
    createdb: bin("createdb"),
    psql: bin("psql"),
    pgDump: bin("pg_dump"),
    pgRestore: bin("pg_restore"),
  };
}

/**
 * PG 도구와 서버에 주는 env. 앱의 env를 물려주지 않는다 — PG가 읽는 PGHOST·PGDATABASE 같은 변수가 셸에서 새어 들어오면
 * 도구가 엉뚱한 서버에 붙는다. LC_ALL=C는 pg_controldata 라벨 파싱을 빌드의 NLS 옵션에서 떼어 낸다 (스펙 §6.2).
 */
export function pgToolEnv(): Record<string, string> {
  return { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" };
}
