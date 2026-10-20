import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiFileSync, removeApiFileIfOwned, writeApiFile } from "../../src/services/api-file";

const DATA = { port: 3001, app_pid: 4242, instance: "inst-a", version: "1.2.3" };

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "api-file-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const read = async () => JSON.parse(await fsp.readFile(path.join(dir, "api.json"), "utf8"));
const exists = (): Promise<boolean> =>
  fsp.access(path.join(dir, "api.json")).then(
    () => true,
    () => false,
  );

describe("writeApiFile", () => {
  it("writes atomically with 0600", async () => {
    await writeApiFile(dir, DATA);
    expect(await read()).toEqual(DATA);
    expect((await fsp.stat(path.join(dir, "api.json"))).mode & 0o777).toBe(0o600);
    // 임시 파일이 남지 않는다 — rename으로 끝났다.
    expect(await fsp.readdir(dir)).toEqual(["api.json"]);
  });

  it("replaces an earlier file", async () => {
    await writeApiFile(dir, DATA);
    await writeApiFile(dir, { ...DATA, instance: "inst-b" });
    expect((await read()).instance).toBe("inst-b");
  });
});

describe("removeApiFileIfOwned", () => {
  it("removes when the instance matches", async () => {
    await writeApiFile(dir, DATA);
    await removeApiFileIfOwned(dir, "inst-a");
    expect(await exists()).toBe(false);
  });

  it("remove skips when instance differs", async () => {
    await writeApiFile(dir, DATA);
    await removeApiFileIfOwned(dir, "someone-else");
    expect(await read()).toEqual(DATA);
  });

  it("remove no-op when file missing", async () => {
    await expect(removeApiFileIfOwned(dir, "inst-a")).resolves.toBeUndefined();
  });

  it("leaves a corrupt file alone", async () => {
    await fsp.writeFile(path.join(dir, "api.json"), "{not json");
    await removeApiFileIfOwned(dir, "inst-a");
    expect(await exists()).toBe(true);
  });
});

describe("createApiFileSync", () => {
  const sync = () => createApiFileSync({ dir, pid: 4242, version: "1.2.3" });
  const up = { process: "running", health: "ok" } as const;

  it("publishes once api is running and ok, with the launch's port and instance", async () => {
    const s = sync();
    await s.update({ process: "starting", health: "unknown" }, { origin: "http://127.0.0.1:3001", instance: "inst-a" });
    expect(await exists()).toBe(false);
    await s.update(up, { origin: "http://127.0.0.1:3001", instance: "inst-a" });
    expect(await read()).toEqual(DATA);
  });

  it("does not publish a degraded api, and keeps a published file through degraded", async () => {
    const s = sync();
    const launch = { origin: "http://127.0.0.1:3001", instance: "inst-a" };
    await s.update({ process: "running", health: "degraded" }, launch);
    expect(await exists()).toBe(false);
    await s.update(up, launch);
    await s.update({ process: "running", health: "degraded" }, launch);
    expect(await exists()).toBe(true);
  });

  it("removes the file when api stops or fails, and republishes under the next launch's instance", async () => {
    const s = sync();
    await s.update(up, { origin: "http://127.0.0.1:3001", instance: "inst-a" });
    await s.update({ process: "failed", health: "unknown" }, { origin: "http://127.0.0.1:3001", instance: "inst-a" });
    expect(await exists()).toBe(false);
    await s.update(up, { origin: "http://127.0.0.1:3002", instance: "inst-b" });
    expect(await read()).toMatchObject({ port: 3002, instance: "inst-b" });
  });

  it("removeNow clears only its own file", async () => {
    const s = sync();
    await s.update(up, { origin: "http://127.0.0.1:3001", instance: "inst-a" });
    await writeApiFile(dir, { ...DATA, instance: "other-app" });
    await s.removeNow();
    expect((await read()).instance).toBe("other-app");
  });
});
