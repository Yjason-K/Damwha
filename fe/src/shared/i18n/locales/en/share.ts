import type { LocaleShape } from "../../locale-shape";
import type { share as ko } from "../ko/share";

export const share = {
  button: "Share",
  status: {
    active: "Shared · until {{date}}",
    pending: "Stopping…",
  },
  dialog: {
    createTitle: "Create a share link",
    manageTitle: "Share link",
    scopeLabel: "What to share",
    scope: {
      summary: "Summary",
      lenses: "Action items, decisions, promises",
      transcript: "Transcript",
      note: "Notes",
    },
    summaryUnavailable: "No summary yet",
    anonymize: "Hide speaker names",
    anonymizeHint: "Names written inside summary or action-item sentences stay as they are. Check the preview.",
    durationLabel: "Share for",
    days_one: "{{count}} day",
    days_other: "{{count}} days",
    previewTitle: "This is what recipients will see",
    previewLoading: "Building the preview…",
    previewFailed: "Couldn't build the preview.",
    notice:
      "Anyone with the link can see this. Summaries and action items can include attendees' names and what they said. The server stores only encrypted data and never the key. The link stops working on {{date}} and the server copy is deleted within an hour after. Edits you make after sharing are not included. Anything a recipient has already copied or captured can't be taken back.",
    consent: "I've read this, and this is fine to share with the attendees",
    transcriptWarning:
      "The transcript contains other attendees' words verbatim. Make sure they agreed before you share. You are responsible for what you share.",
    transcriptAck: "The attendees agreed, and I understand I'm responsible for sharing this",
    replaceWarning_one:
      "The current link ({{count}} day left) stops right away and is deleted from the server. People who have it can no longer open it.",
    replaceWarning_other:
      "The current link ({{count}} days left) stops right away and is deleted from the server. People who have it can no longer open it.",
    submit: "Create link",
    cancel: "Cancel",
    created: "Share link created.",
    linkLabel: "Share link",
    copy: "Copy link",
    copied: "Link copied.",
    expiresOn: "The link stops working on {{date}}.",
    stop: "Stop sharing",
    stopped: "Sharing stopped.",
    newLink: "Create a new link",
    pendingNotice: "Waiting to stop. It will stop once you're back online.",
  },
  errors: {
    SHARE_IN_PROGRESS: "A share link for this meeting is already being created.",
    SHARE_SERVICE_UNREACHABLE: "You need to be online to share.",
    SHARE_SERVICE_BUSY: "The share server is busy. Please try again shortly.",
    SHARE_TOO_LARGE: "This is too large to share. Try again without the transcript.",
    SUMMARY_NOT_READY: "The summary isn't ready yet.",
    MEETING_DELETED: "The meeting was deleted, so it wasn't shared.",
    generic: "Couldn't share.",
  },
  settings: {
    title: "Shared links",
    description: "Links that are shared now or waiting to stop.",
    empty: "No shared links.",
    deletedMeeting: "Deleted meeting",
    until: "until {{date}}",
    pending: "Stopping…",
  },
  deleteMeeting: {
    activeShare: "Its share link will stop too.",
    pendingToast:
      "You're offline. The share link will stop the next time you're online, and no later than {{date}}.",
  },
} satisfies LocaleShape<typeof ko>;
