# 공유 서버 배포 (개인 서버 + Cloudflare Tunnel)

spec: `docs/superpowers/specs/2026-10-09-meeting-share-selfhost-v2-design.md` §2.4.

## 띄우기

    git pull && docker compose -f deploy/share/docker-compose.yml up -d --build
    curl -s http://127.0.0.1:8787/healthz     # {"ok":true}

## 공개 (Cloudflare Tunnel)

같은 호스트의 cloudflared에 ingress 한 줄을 더하고 DNS를 연결한다:

    # ~/.cloudflared/config.yml
    ingress:
      - hostname: damwha-share.0kimjae.dev
        service: http://127.0.0.1:8787
      - service: http_status:404

    cloudflared tunnel route dns <터널 이름> damwha-share.0kimjae.dev

cloudflared를 Docker로 돌린다면 이 compose의 `ports`를 지우고 같은 Docker 네트워크에 두고
`service: http://share:8787`로 잇는다. 어느 쪽이든 **8787을 바깥 인터페이스에 열지 않는다.**

## 운영

- 업로드만 긴급 차단: compose의 `UPLOADS_ENABLED: "false"` → `docker compose up -d`. 열람·삭제는 그대로.
- 일일 상한·IP별 제한: `DAILY_MAX_UPLOADS`, `DAILY_MAX_BYTES`, `UPLOAD_LIMIT_PER_MIN`, `READ_LIMIT_PER_MIN`, `DELETE_LIMIT_PER_MIN`.
  카운터는 메모리라 재시작하면 0부터 센다.
- **백업에서 `damwha_share_data` 볼륨을 뺀다.** 백업에 남으면 만료 삭제 약속이 깨진다.
- 만료 파일은 서버가 10분마다 지운다. 서버가 꺼져 있던 동안 만료된 것은 다시 켜질 때 지운다.
- 로그(`docker compose logs share`)에는 메서드·경로·상태만 남는다.
