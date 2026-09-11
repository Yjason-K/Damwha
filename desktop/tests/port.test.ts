import { describe, expect, it } from "vitest";
import * as net from "net";
import { MAX_PORT_ATTEMPTS, choosePort, freePort, isAddrInUse } from "../src/port";

describe("choosePort", () => {
  it("uses the preferred port on the first attempt", async () => {
    let probed = false;
    const port = await choosePort(3000, 0, async () => {
      probed = true;
      return 51000;
    });
    expect(port).toBe(3000);
    expect(probed).toBe(false);
  });

  it("probes for a port on later attempts", async () => {
    expect(await choosePort(3000, 1, async () => 51000)).toBe(51000);
    expect(await choosePort(3000, 2, async () => 51001)).toBe(51001);
  });

  it("rejects a port outside 1-65535", async () => {
    await expect(choosePort(0, 0)).rejects.toThrow(/preferred port/);
    await expect(choosePort(70000, 0)).rejects.toThrow(/preferred port/);
    await expect(choosePort(3.5, 0)).rejects.toThrow(/preferred port/);
  });

  it("rejects a negative attempt index", async () => {
    await expect(choosePort(3000, -1)).rejects.toThrow(/attempt/);
  });
});

describe("freePort", () => {
  it("returns a port nothing is listening on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });
});

describe("isAddrInUse", () => {
  it("recognises the node bind error", () => {
    expect(isAddrInUse("Error: listen EADDRINUSE: address already in use 127.0.0.1:3000")).toBe(true);
  });

  it("does not match an unrelated startup failure", () => {
    expect(isAddrInUse("startup failed: database unreachable at postgres://...")).toBe(false);
    expect(isAddrInUse("")).toBe(false);
  });
});

describe("MAX_PORT_ATTEMPTS", () => {
  it("is a small finite number so the retry loop terminates", () => {
    expect(MAX_PORT_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_PORT_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
