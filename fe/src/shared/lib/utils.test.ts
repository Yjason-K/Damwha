import { expect, test } from "vitest";
import { cn } from "@/shared/lib/utils";

test("cn은 클래스를 병합하고 tailwind 충돌을 해결한다", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn("text-sm", undefined, null, "font-bold")).toBe("text-sm font-bold");
});
