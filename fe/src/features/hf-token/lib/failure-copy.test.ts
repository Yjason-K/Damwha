import { expect, test } from "vitest";
import { hfFailureCopy } from "./failure-copy";

test("401 points to the token, 403 to the conditions page", () => {
  expect(hfFailureCopy("hf_token_invalid")).toMatchObject({ action: "token" });
  expect(hfFailureCopy("hf_token_invalid")!.body).toContain("재처리");
  expect(hfFailureCopy("hf_gate_not_accepted")).toMatchObject({
    action: "accept",
  });
  expect(hfFailureCopy("hf_gate_not_accepted")!.body).toContain("재처리");
});

test("anything else keeps the generic banner", () => {
  for (const code of [
    undefined,
    "audio_device_failed",
    "model_download_failed",
    "DISK_FULL",
  ]) {
    expect(hfFailureCopy(code)).toBeNull();
  }
});
