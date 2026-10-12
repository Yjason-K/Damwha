import type { Pool } from 'pg';

/** 공유 테스트용 회의 하나: 화자 1명(+미확정 1), 발화 3(하나는 본문 있는 silence), 요약 done, 렌즈 1(근거 있음), 메모. */
export async function seedSharedMeeting(pool: Pool) {
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];
  const speakerId = (await q(`INSERT INTO speaker(name, is_me) VALUES('김담화', true) RETURNING id`)).id as string;
  const meetingId = (await q(
    `INSERT INTO meeting(audio_key,status,title,duration_ms,processing_version) VALUES('a','done','주간 회의',60000,1) RETURNING id`,
  )).id as string;
  const u1 = (await q(
    `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
     VALUES($1,$2,'SPEAKER_00',1000,3000,'화요일에 배포하죠',0,1) RETURNING id`,
    [meetingId, speakerId],
  )).id as string;
  await pool.query(
    `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
     VALUES($1,'SPEAKER_01',4000,5000,'좋아요',1,1)`,
    [meetingId],
  );
  // silence 발화에도 본문을 둔다 — 본문이 비면 "본문 있음" 조건만으로 shared=false가 돼서 status 조건이
  // 빠져도 근거-silence 테스트가 초록으로 남는다(변이 확인이 붉어질 수 없다).
  await pool.query(
    `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
     VALUES($1,'SPEAKER_01',6000,7000,'음','silence',2,1)`,
    [meetingId],
  );
  await pool.query(
    `INSERT INTO meeting_summary(meeting_id,processing_version,model,status,topics,segments)
     VALUES($1,1,'m','done',$2::jsonb,$3::jsonb)`,
    [meetingId, JSON.stringify(['배포']), JSON.stringify([{ start_utterance_id: u1, end_utterance_id: u1, start_ms: 1000, end_ms: 3000, title: '배포', bullets: ['화요일'] }])],
  );
  const lensId = (await q(
    `INSERT INTO lens_item(meeting_id,kind,text,source,assignee_speaker_id,due_at)
     VALUES($1,'action','릴리스 노트','user',$2,'2026-10-14') RETURNING id`,
    [meetingId, speakerId],
  )).id as string;
  await pool.query(`INSERT INTO lens_evidence(lens_item_id,utterance_id,relation) VALUES($1,$2,'primary')`, [lensId, u1]);
  await pool.query(`INSERT INTO meeting_note(meeting_id, body_md) VALUES($1,'## 메모')`, [meetingId]);
  return { meetingId, speakerId, u1, lensId };
}
