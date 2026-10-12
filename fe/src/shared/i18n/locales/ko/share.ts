/** 회의 공유 (features/share). */
export const share = {
  button: "공유",
  status: {
    active: "공유 중 · {{date}}까지",
    pending: "중지 대기 중",
  },
  dialog: {
    createTitle: "공유 링크 만들기",
    manageTitle: "공유 링크",
    scopeLabel: "공유할 내용",
    scope: {
      summary: "요약",
      lenses: "할 일·결정·약속",
      transcript: "발화 기록",
      note: "메모",
    },
    summaryUnavailable: "요약이 아직 없어요",
    anonymize: "화자 이름 가리기",
    anonymizeHint: "요약·할 일 문장 안에 적힌 이름은 그대로 남아요. 미리보기에서 확인해 주세요.",
    durationLabel: "공유 기간",
    days_one: "{{count}}일",
    days_other: "{{count}}일",
    previewTitle: "받는 사람에게 이렇게 보여요",
    previewLoading: "미리보기를 만드는 중…",
    previewFailed: "미리보기를 만들지 못했어요.",
    notice:
      "링크를 가진 사람은 누구나 이 내용을 볼 수 있어요. 요약·할 일에도 참석자의 이름과 발언 내용이 담길 수 있어요. 서버에는 암호문만 저장되고 키는 저장하지 않아요. 링크는 {{date}}에 막히고 서버 기록은 그 뒤 한 시간 안에 삭제돼요. 공유한 뒤 회의를 고쳐도 반영되지 않아요. 받은 사람이 이미 복사하거나 캡처한 내용은 되돌릴 수 없어요.",
    consent: "위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요",
    transcriptWarning:
      "발화 기록에는 다른 참석자의 발언이 그대로 담겨 있어요. 공유하기 전에 참석자에게 허락을 받았는지 확인해 주세요. 공유로 생기는 책임은 공유한 사람에게 있어요.",
    transcriptAck: "참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요",
    replaceWarning_one:
      "기존 링크({{count}}일 남음)는 바로 중지되고 서버에서 삭제돼요. 기존 링크를 받은 사람은 더 이상 볼 수 없어요.",
    replaceWarning_other:
      "기존 링크({{count}}일 남음)는 바로 중지되고 서버에서 삭제돼요. 기존 링크를 받은 사람은 더 이상 볼 수 없어요.",
    submit: "링크 만들기",
    cancel: "취소",
    created: "공유 링크를 만들었어요.",
    linkLabel: "공유 링크",
    copy: "링크 복사",
    copied: "링크를 복사했어요.",
    expiresOn: "{{date}}에 링크가 막혀요.",
    stop: "공유 중지",
    stopped: "공유를 중지했어요.",
    newLink: "새 링크 만들기",
    pendingNotice: "중지 대기 중이에요. 인터넷에 연결되면 중지돼요.",
  },
  errors: {
    SHARE_IN_PROGRESS: "이미 이 회의의 공유 링크를 만드는 중이에요.",
    SHARE_SERVICE_UNREACHABLE: "인터넷에 연결해야 공유할 수 있어요.",
    SHARE_SERVICE_BUSY: "공유 서버가 지금 바빠요. 잠시 후 다시 시도해 주세요.",
    SHARE_TOO_LARGE: "공유할 내용이 너무 커요. 발화 기록을 빼고 다시 시도해 주세요.",
    SUMMARY_NOT_READY: "요약이 아직 준비되지 않았어요.",
    MEETING_DELETED: "회의가 삭제되어 공유하지 못했어요.",
    generic: "공유하지 못했어요.",
  },
  settings: {
    title: "공유한 링크",
    description: "지금 공유 중이거나 중지를 기다리는 링크예요.",
    empty: "공유 중인 링크가 없어요.",
    deletedMeeting: "삭제된 회의",
    until: "{{date}}까지",
    pending: "중지 대기 중",
  },
  deleteMeeting: {
    activeShare: "이 회의의 공유 링크도 중지돼요.",
    pendingToast:
      "인터넷에 연결되어 있지 않아요. 공유 링크는 다음에 연결될 때 중지되고, 늦어도 {{date}}에는 막혀요.",
  },
};
