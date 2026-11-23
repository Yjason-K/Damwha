import type { LocaleShape } from "../../locale-shape";
import type { common as ko } from "../ko/common";

export const common = {
  test: {
    echo: "{{value}}",
  },
  routeError: {
    title: "This screen couldn't be shown",
    description:
      "An unexpected error stopped this screen from loading. Try again or go to another screen.",
    retry: "Try again",
    reload: "Reload",
    reloadBlocked:
      "Reloading now would cut off the recording. Stop the recording first.",
    reloadBlockedStarting:
      "A recording is starting. You can reload once it has started.",
    recording: {
      title: "Recording is still running",
      description:
        "You can stop the recording right here. Everything recorded so far is kept.",
      stop: "Stop recording",
      stopping: "Stopping…",
      stopFailed: "Couldn't stop the recording. Please try again.",
      stopped: "Recording stopped. Processing continues on the meeting screen.",
      discarded: "Nothing was recorded, so the meeting was removed.",
    },
  },
} satisfies LocaleShape<typeof ko>;
