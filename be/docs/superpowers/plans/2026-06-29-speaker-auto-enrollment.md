# Speaker Auto-Enrollment + Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 처리 시 미식별 화자를 `Speaker_NNN` provisional 화자로 자동 생성(확인 전 매칭 제외)하고, voiceprint provenance로 resolve 오염을 막으며, 화자 이름 변경(PATCH)을 추가한다.

**Architecture:** Worker `persist`가 가드 TX 안에서 미식별 cluster마다 provisional speaker + `auto_cluster` voiceprint(`source_cluster_id`)를 만든다. identify는 `ready`만 매칭하므로 provisional은 확인(rename) 전까지 제외된다. resolve는 cluster+speaker 잠금으로 PATCH와 직렬화되고, `source_cluster_id` 부분 유일 인덱스 + UPSERT로 voiceprint를 *재귀속*(복사 아님)하며 provisional 고아를 조건부 DELETE한다.

**Tech Stack:** NestJS(TS, raw SQL via `DatabaseService`), Python worker(psycopg3, pydantic v2), Postgres(pgvector), Jest+Testcontainers, pytest+Testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-29-speaker-auto-enrollment-design.md`

## Global Constraints

- **No ORM** — raw SQL only (`DatabaseService.query`/`withTransaction`, psycopg `conn.execute`).
- **Job payload 계약 불변** — `provisional`은 DB 컬럼 값일 뿐 zod/pydantic 계약·픽스처와 무관. `src/contracts/`, `worker/damwha_worker/contracts.py` 건드리지 않는다.
- **Enums = text + CHECK** (native enum 아님). CHECK 목록을 source of truth로 유지.
- **voiceprint는 `vector(192)` 고정**, identify는 `model`+`dimension` 일치 + `enrollment_status='ready'`만 매칭.
- **API/worker는 `job` 테이블로만 통신** — `src/`에 ML/네트워크 호출 추가 금지.
- **Migrations는 추가만** — 적용된 파일 수정 금지(`001`/`002`/`003` 불변). 새 번호 파일.
- Node **22** (`nvm use` 먼저), worker Python **3.12** (`uv`).
- 기본 이름 prefix 기본값 `"Speaker"`, 번호는 전역 시퀀스 `speaker_default_seq`(중복 없음, 간격 정상).

---

## File Structure

**Create**
- `src/database/migrations/004_speaker_auto_enroll.sql` — provisional CHECK, 시퀀스, `voiceprint.source_cluster_id` + 부분 유일 인덱스.

**Modify (API)**
- `test/db.ts` — reset에 `ALTER SEQUENCE speaker_default_seq RESTART`.
- `test/migration.spec.ts` — 004 스키마/동작 테스트.
- `src/speakers/speakers.repository.ts` / `speakers.service.ts` / `speakers.controller.ts` — rename.
- `test/speakers.e2e-spec.ts` — rename 테스트.
- `src/meetings/meetings.repository.ts` — cluster 잠금 + resolved_speaker_id, speaker 잠금, ready speaker 생성, provisional 승격, voiceprint UPSERT, 고아 DELETE, `findUtterances` speaker join.
- `src/meetings/meetings.service.ts` — `resolveCluster` 재작성.
- `test/clusters.e2e-spec.ts` / `test/meetings.e2e-spec.ts` — resolve/join 테스트.

**Modify (worker)**
- `worker/damwha_worker/db.py` — `persist_process_meeting` provisional 생성.
- `worker/damwha_worker/pipeline/process_meeting.py` — prefix/embedding 전달.
- `worker/damwha_worker/__main__.py` — `handle_job`/`run_once`/`dispatch_claimed_job` 배선.
- `worker/damwha_worker/config.py` — `default_speaker_prefix` + validator.
- `worker/tests/conftest.py` — reset에 시퀀스 RESTART.
- `worker/tests/test_db_persist.py` / `test_process_meeting.py` / `test_identify.py` / `test_config.py` / `test_worker_loop.py` — 신규/수정 테스트.

**Docs**
- `CLAUDE.md` — speaker identification invariant 갱신.

---

## Task 1: Migration 004 + schema/behavior tests

**Files:**
- Create: `src/database/migrations/004_speaker_auto_enroll.sql`
- Modify: `test/db.ts:24-28`
- Test: `test/migration.spec.ts` (append)

**Interfaces:**
- Produces: `speaker.enrollment_status` 허용값에 `'provisional'`; 시퀀스 `speaker_default_seq`; `voiceprint.source_cluster_id uuid` + 부분 유일 인덱스 `voiceprint_source_cluster_uniq`.

- [ ] **Step 1: Write the migration**

Create `src/database/migrations/004_speaker_auto_enroll.sql`:

```sql
-- provisional 상태값 추가 (text + CHECK 진화)
ALTER TABLE speaker DROP CONSTRAINT speaker_enrollment_status_check;
ALTER TABLE speaker ADD CONSTRAINT speaker_enrollment_status_check
  CHECK (enrollment_status IN ('pending','ready','provisional','failed'));

-- 기본 이름 전역 시퀀스 (Speaker_NNN, 중복 없음)
CREATE SEQUENCE speaker_default_seq;

-- voiceprint provenance: 어느 cluster centroid에서 만들어졌는가
ALTER TABLE voiceprint
  ADD COLUMN source_cluster_id uuid REFERENCES meeting_cluster(id) ON DELETE SET NULL;

-- cluster당 voiceprint ≤ 1 (중복 삽입 구조적 차단 + UPSERT 대상)
CREATE UNIQUE INDEX voiceprint_source_cluster_uniq
  ON voiceprint (source_cluster_id) WHERE source_cluster_id IS NOT NULL;
```

> 참고: `001_init.sql`의 인라인 컬럼 CHECK는 Postgres가 `speaker_enrollment_status_check`로 자동 명명한다. 만약 이름이 다르면 `\d speaker`로 확인 후 DROP 대상 이름을 맞춘다.

- [ ] **Step 2: Update test reset to restart the sequence**

In `test/db.ts`, replace the `reset` body:

```typescript
    reset: async () => {
      await pool.query(
        `TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker RESTART IDENTITY CASCADE`,
      );
      await pool.query(`ALTER SEQUENCE speaker_default_seq RESTART`);
    },
```

- [ ] **Step 3: Write the failing tests**

Append to `test/migration.spec.ts` inside the `describe('migration', …)` block:

```typescript
  it('004: accepts provisional, rejects bogus enrollment_status', async () => {
    await expect(
      db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('p','provisional')`),
    ).resolves.toBeDefined();
    await expect(
      db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('b','bogus')`),
    ).rejects.toThrow(/check constraint/i);
  });

  it('004: speaker_default_seq yields increasing values', async () => {
    const a = await db.pool.query(`SELECT nextval('speaker_default_seq')::int AS n`);
    const b = await db.pool.query(`SELECT nextval('speaker_default_seq')::int AS n`);
    expect(b.rows[0].n).toBeGreaterThan(a.rows[0].n);
  });

  it('004: source_cluster_id is unique when non-null, many NULL allowed', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('s') RETURNING id`);
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version)
       VALUES($1,'S0',0) RETURNING id`,
      [m.rows[0].id],
    );
    const vec = '[' + Array(192).fill(0.1).join(',') + ']';
    const insVp = (clusterId: string | null) =>
      db.pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source_cluster_id)
         VALUES($1,$2::vector,'m',192,$3)`,
        [sp.rows[0].id, vec, clusterId],
      );
    await insVp(null);
    await expect(insVp(null)).resolves.toBeDefined(); // multiple NULL ok
    await insVp(c.rows[0].id);
    await expect(insVp(c.rows[0].id)).rejects.toThrow(/duplicate key|unique/i); // dup non-null
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `nvm use && npx jest test/migration.spec.ts`
Expected: FAIL — `004:` tests error (constraint allows no provisional / sequence missing / source_cluster_id column missing) before the migration is applied. (If the test DB image is cached, the new migration runs on the fresh container per suite.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/migration.spec.ts`
Expected: PASS (all migration tests, including the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations/004_speaker_auto_enroll.sql test/db.ts test/migration.spec.ts
git commit -m "feat(db): migration 004 — provisional status, speaker_default_seq, voiceprint.source_cluster_id"
```

---

## Task 2: Worker persist auto-creates provisional speakers

**Files:**
- Modify: `worker/damwha_worker/db.py:115-234` (`persist_process_meeting`)
- Modify: `worker/tests/conftest.py:34-39` (reset)
- Test: `worker/tests/test_db_persist.py`

**Interfaces:**
- Consumes: migration 004 (Task 1), `db._vec`.
- Produces: `persist_process_meeting(..., embedding_model=None, embedding_dim=None, default_speaker_prefix="Speaker", index_search_model=None, index_search_dim=None)`. For each cluster in `clusters` with a centroid it INSERTs a `provisional` speaker `<<prefix>>_NNN` + `voiceprint(source='auto_cluster', source_cluster_id=<cluster>)`, sets the cluster's `resolved_speaker_id`, and assigns matching utterances. centroid `None` → unresolved cluster only (no speaker/voiceprint).

- [ ] **Step 1: Add sequence reset to the worker test fixture**

In `worker/tests/conftest.py`, the `conn` fixture finalizer — after the TRUNCATE add a sequence restart:

```python
        c.execute(
            "TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker "
            "RESTART IDENTITY CASCADE"
        )
        c.execute("ALTER SEQUENCE speaker_default_seq RESTART")
        c.close()
```

- [ ] **Step 2: Write the failing test (provisional auto-create)**

Add to `worker/tests/test_db_persist.py`:

```python
def test_persist_auto_creates_provisional_for_unidentified(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "SPEAKER_00",
                "start_ms": 0,
                "end_ms": 1,
                "text": "a",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[
            {"diar_label": "SPEAKER_00", "centroid": [0.1] * 192, "resolved_speaker_id": None}
        ],
        embedding_model="speechbrain/spkrec-ecapa-voxceleb",
        embedding_dim=192,
        default_speaker_prefix="Speaker",
    )
    assert out == "committed"
    sp = conn.execute(
        "SELECT id, name, enrollment_status FROM speaker", ()
    ).fetchall()
    assert len(sp) == 1
    assert sp[0]["enrollment_status"] == "provisional"
    assert sp[0]["name"].startswith("Speaker_")
    sid = sp[0]["id"]
    # cluster resolved to the new provisional speaker
    cl = conn.execute(
        "SELECT resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert cl["resolved_speaker_id"] == sid
    # voiceprint with provenance
    vp = conn.execute(
        "SELECT speaker_id, source, source_cluster_id FROM voiceprint WHERE speaker_id=%s", (sid,)
    ).fetchone()
    assert vp["source"] == "auto_cluster" and vp["source_cluster_id"] is not None
    # utterance assigned to the provisional speaker
    u = conn.execute(
        "SELECT speaker_id FROM utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert u["speaker_id"] == sid


def test_persist_centroidless_cluster_makes_no_speaker(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "SPEAKER_00",
                "start_ms": 0,
                "end_ms": 1,
                "text": "a",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[{"diar_label": "SPEAKER_00", "centroid": None, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    assert out == "committed"
    assert conn.execute("SELECT count(*) c FROM speaker", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) c FROM voiceprint", ()).fetchone()["c"] == 0
    cl = conn.execute(
        "SELECT resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert cl["resolved_speaker_id"] is None  # unresolved cluster kept
    u = conn.execute("SELECT speaker_id FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()
    assert u["speaker_id"] is None


def test_persist_names_are_unique_across_two_meetings(conn):
    names = []
    for _ in range(2):
        mid, jid = _claimed_pm_job(conn, pv=0)
        db.persist_process_meeting(
            conn,
            job_id=jid,
            worker_id="w1",
            meeting_id=mid,
            processing_version=0,
            normalized_key="k",
            duration_ms=1,
            utterances=[],
            clusters=[
                {"diar_label": "S0", "centroid": [0.1] * 192, "resolved_speaker_id": None}
            ],
            embedding_model="m",
            embedding_dim=192,
        )
    rows = conn.execute("SELECT name FROM speaker ORDER BY name", ()).fetchall()
    names = [r["name"] for r in rows]
    assert len(names) == 2 and len(set(names)) == 2  # unique
    import re

    assert all(re.fullmatch(r"Speaker_\d{3,}", n) for n in names)
```

- [ ] **Step 3: Update the existing commit test to assert new behavior**

In `worker/tests/test_db_persist.py`, `test_persist_commits_results` passes a centroid cluster — under the new design it now also creates a provisional speaker. Add `embedding_model`/`embedding_dim` to the call and assert the speaker exists. Replace its `db.persist_process_meeting(...)` call args by adding, after `clusters=[...]`:

```python
        clusters=[
            {"diar_label": "SPEAKER_00", "centroid": [0.1] * 192, "resolved_speaker_id": None}
        ],
        embedding_model="speechbrain/spkrec-ecapa-voxceleb",
        embedding_dim=192,
    )
```

And append one assertion at the end of `test_persist_commits_results`:

```python
    assert (
        conn.execute(
            "SELECT count(*) c FROM speaker WHERE enrollment_status='provisional'", ()
        ).fetchone()["c"]
        == 1
    )
```

- [ ] **Step 4: Run the new/updated tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_db_persist.py -q`
Expected: FAIL — `persist_process_meeting()` got an unexpected keyword argument `embedding_model` / no provisional speaker created.

- [ ] **Step 5: Implement provisional creation in `persist_process_meeting`**

In `worker/damwha_worker/db.py`, change the signature of `persist_process_meeting` to add the three params (place `embedding_model`, `embedding_dim`, `default_speaker_prefix` before `index_search_model`):

```python
def persist_process_meeting(
    conn,
    *,
    job_id,
    worker_id,
    meeting_id,
    processing_version,
    normalized_key,
    duration_ms,
    utterances,
    clusters,
    embedding_model=None,
    embedding_dim=None,
    default_speaker_prefix="Speaker",
    index_search_model=None,
    index_search_dim=None,
) -> str:
```

Then, in the fresh path, **replace** the existing utterance-insert loop and cluster-insert loop (currently `for u in utterances: …` followed by `for c in clusters: …`) with this — provisional speakers + clusters first (building the label map), then utterances:

```python
            # fresh: replace results
            conn.execute("DELETE FROM utterance WHERE meeting_id=%s", (meeting_id,))
            conn.execute("DELETE FROM meeting_cluster WHERE meeting_id=%s", (meeting_id,))

            # 미식별 cluster → provisional speaker + voiceprint(provenance) 자동 생성
            label_to_new_speaker: dict[str, str] = {}
            for c in clusters:
                centroid = c["centroid"]
                if centroid is None:
                    # centroid 없음: speaker/voiceprint 없이 미해소 cluster만 보존
                    conn.execute(
                        """
                        INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                            resolved_speaker_id, processing_version, job_id)
                        VALUES (%s,%s,NULL,NULL,%s,%s)
                        """,
                        (meeting_id, c["diar_label"], processing_version, job_id),
                    )
                    continue
                sid = conn.execute(
                    """
                    INSERT INTO speaker(name, enrollment_status)
                    VALUES (%s || '_' || lpad(nextval('speaker_default_seq')::text, 3, '0'),
                            'provisional')
                    RETURNING id
                    """,
                    (default_speaker_prefix,),
                ).fetchone()["id"]
                cid = conn.execute(
                    """
                    INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                        resolved_speaker_id, processing_version, job_id)
                    VALUES (%s,%s,%s::vector,%s,%s,%s)
                    RETURNING id
                    """,
                    (meeting_id, c["diar_label"], _vec(centroid), sid, processing_version, job_id),
                ).fetchone()["id"]
                conn.execute(
                    """
                    INSERT INTO voiceprint(speaker_id, embedding, model, dimension,
                        source, source_cluster_id)
                    VALUES (%s,%s::vector,%s,%s,'auto_cluster',%s)
                    """,
                    (sid, _vec(centroid), embedding_model, embedding_dim, cid),
                )
                label_to_new_speaker[c["diar_label"]] = sid

            for u in utterances:
                speaker_id = u["speaker_id"] or label_to_new_speaker.get(u["diar_label"])
                conn.execute(
                    """
                    INSERT INTO utterance(meeting_id, speaker_id, diar_label,
                        start_ms, end_ms, text, confidence, status,
                        transcript_error, order_index, processing_version, job_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        meeting_id,
                        speaker_id,
                        u["diar_label"],
                        u["start_ms"],
                        u["end_ms"],
                        u["text"],
                        u["confidence"],
                        u["status"],
                        Jsonb(u["transcript_error"]) if u["transcript_error"] is not None else None,
                        u["order_index"],
                        processing_version,
                        job_id,
                    ),
                )
```

(Leave the `UPDATE job … done` + `index_meeting` enqueue block that follows unchanged.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_db_persist.py -q`
Expected: PASS (new provisional tests + updated commit test + untouched discard/lost/index tests).

- [ ] **Step 7: Commit**

```bash
git add worker/damwha_worker/db.py worker/tests/test_db_persist.py worker/tests/conftest.py
git commit -m "feat(worker): persist auto-creates provisional speakers + auto_cluster voiceprints"
```

---

## Task 3: Wire prefix/embedding through the pipeline + config validator

**Files:**
- Modify: `worker/damwha_worker/pipeline/process_meeting.py:35-52,146-164`
- Modify: `worker/damwha_worker/__main__.py` (`handle_job`, `run_once`, `dispatch_claimed_job`)
- Modify: `worker/damwha_worker/config.py`
- Test: `worker/tests/test_process_meeting.py`, `test_identify.py`, `test_config.py`, `test_worker_loop.py`

**Interfaces:**
- Consumes: `persist_process_meeting(..., embedding_model, embedding_dim, default_speaker_prefix)` (Task 2).
- Produces: `run_process_meeting(..., default_speaker_prefix="Speaker")` forwards prefix + `payload.models.embedding.{model,dimension}` to persist. `handle_job(..., default_speaker_prefix="Speaker")` and `run_once(..., default_speaker_prefix="Speaker")` forward it. `dispatch_claimed_job` passes `settings.default_speaker_prefix`. `Settings.default_speaker_prefix: str = "Speaker"` (stripped, non-empty).

- [ ] **Step 1: Write the failing config validator test**

Append to `worker/tests/test_config.py`:

```python
def test_default_speaker_prefix_default_and_strip(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    s = load_settings()
    assert s.default_speaker_prefix == "Speaker"  # default
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "  화자  ")
    assert load_settings().default_speaker_prefix == "화자"  # stripped


def test_default_speaker_prefix_rejects_blank(monkeypatch):
    import pytest

    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "   ")
    with pytest.raises(Exception):
        load_settings()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/test_config.py -q`
Expected: FAIL — `Settings` has no attribute `default_speaker_prefix`.

- [ ] **Step 3: Add the config field + validator**

In `worker/damwha_worker/config.py`, add the import and field:

```python
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
```

Add inside `Settings` (after `embed_service_port`):

```python
    default_speaker_prefix: str = "Speaker"

    @field_validator("default_speaker_prefix")
    @classmethod
    def _non_empty_prefix(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("default_speaker_prefix must not be empty")
        return v
```

- [ ] **Step 4: Run config tests to verify pass**

Run: `cd worker && uv run pytest tests/test_config.py -q`
Expected: PASS.

- [ ] **Step 5: Forward prefix/embedding in `run_process_meeting`**

In `worker/damwha_worker/pipeline/process_meeting.py`, add `default_speaker_prefix` to the signature (after `probe_fn`):

```python
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
    default_speaker_prefix: str = "Speaker",
) -> str:
```

In the persist call (the `db.persist_process_meeting(...)` block), add the three kwargs alongside the existing ones:

```python
        outcome = db.persist_process_meeting(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            processing_version=payload.processing_version,
            normalized_key=norm_key,
            duration_ms=duration_ms,
            utterances=utterance_rows,
            clusters=cluster_rows,
            embedding_model=payload.models.embedding.model,
            embedding_dim=payload.models.embedding.dimension,
            default_speaker_prefix=default_speaker_prefix,
            index_search_model=search_embedding_model,
            index_search_dim=search_embedding_dim,
        )
```

- [ ] **Step 6: Forward prefix in `handle_job`/`run_once`/`dispatch_claimed_job`**

In `worker/damwha_worker/__main__.py`:

`handle_job` — add the param and pass it to `run_process_meeting`:

```python
def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    build_models=None,
    build_text_embedder=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
) -> str:
```

and inside the `process_meeting` branch, add `default_speaker_prefix=default_speaker_prefix` to the `run_process_meeting(...)` call:

```python
            return run_process_meeting(
                conn,
                job,
                payload,
                models,
                storage,
                worker_id=worker_id,
                search_embedding_model=sm,
                search_embedding_dim=sd,
                default_speaker_prefix=default_speaker_prefix,
            )
```

`run_once` — add the param and forward:

```python
def run_once(
    conn,
    worker_id: str,
    storage: Storage,
    *,
    build_models=None,
    build_text_embedder=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(
        conn,
        job,
        storage,
        worker_id,
        build_models=build_models,
        build_text_embedder=build_text_embedder,
        search_embedding=search_embedding,
        default_speaker_prefix=default_speaker_prefix,
    )
```

`dispatch_claimed_job` — pass the setting into `handle_job`:

```python
    with heartbeat_cm:
        return handle_job(
            conn,
            job,
            storage,
            settings.worker_id,
            build_models=lambda: build_models_fn(job["payload"], settings),
            build_text_embedder=lambda: build_text_embedder_fn(settings),
            search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
            default_speaker_prefix=settings.default_speaker_prefix,
        )
```

- [ ] **Step 7: Update the e2e pipeline test + add prefix-flow + provisional-excluded tests**

In `worker/tests/test_process_meeting.py`, update `test_full_pipeline_with_identification` — SPEAKER_01 is now auto-enrolled. Replace the post-`out` assertions block with:

```python
    assert out == "committed"
    utts = conn.execute(
        "SELECT diar_label, speaker_id, text FROM utterance "
        "WHERE meeting_id=%s ORDER BY order_index",
        (mid,),
    ).fetchall()
    assert utts[0]["diar_label"] == "SPEAKER_00" and utts[0]["speaker_id"] == sid
    # SPEAKER_01 now gets an auto-created provisional speaker (not None)
    prov = conn.execute(
        "SELECT id, name, enrollment_status FROM speaker WHERE enrollment_status='provisional'", ()
    ).fetchone()
    assert prov is not None and prov["name"].startswith("Speaker_")
    assert utts[1]["speaker_id"] == prov["id"]
    # its cluster + auto_cluster voiceprint exist
    cl = conn.execute(
        "SELECT diar_label, resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert [c["diar_label"] for c in cl] == ["SPEAKER_01"]
    assert cl[0]["resolved_speaker_id"] == prov["id"]
    vp = conn.execute(
        "SELECT source FROM voiceprint WHERE speaker_id=%s", (prov["id"],)
    ).fetchone()
    assert vp["source"] == "auto_cluster"
```

Add a prefix-flow test (proves `run_process_meeting` → persist carries the prefix):

```python
def test_run_process_meeting_uses_custom_prefix(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        default_speaker_prefix="화자",
    )
    names = [
        r["name"]
        for r in conn.execute("SELECT name FROM speaker", ()).fetchall()
    ]
    assert names and all(n.startswith("화자_") for n in names)
```

In `worker/tests/test_identify.py`, add a provisional-excluded regression test:

```python
def test_identify_ignores_provisional_speaker(conn):
    prov = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=prov, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": [1.0] + [0.0] * 191},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.5,
    )
    assert out["S0"] is None
```

- [ ] **Step 8: Add the dispatch wiring test**

In `worker/tests/test_worker_loop.py`, update `_settings_stub()` to include the new field, then add a full-chain wiring test:

```python
def _settings_stub():
    return SimpleNamespace(
        worker_id="w1",
        search_embedding_model="BAAI/bge-m3",
        search_embedding_dim=1024,
        default_speaker_prefix="Speaker",
    )


def test_dispatch_passes_prefix_through_to_persist(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)  # no seeded voiceprint → S0 unidentified → provisional
    job = db.claim(conn, "w1")
    settings = SimpleNamespace(
        worker_id="w1",
        search_embedding_model="BAAI/bge-m3",
        search_embedding_dim=1024,
        default_speaker_prefix="Zz",
    )
    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        settings,
        build_models_fn=lambda payload, s: _models(),
        build_text_embedder_fn=lambda s: None,
        heartbeat_cm=_SpyCM(),
    )
    assert out == "committed"
    names = [r["name"] for r in conn.execute("SELECT name FROM speaker", ()).fetchall()]
    assert names and all(n.startswith("Zz_") for n in names)
```

- [ ] **Step 9: Run the worker suite**

Run: `cd worker && uv run pytest -q`
Expected: PASS (all worker tests).

- [ ] **Step 10: Lint + format**

Run: `cd worker && uv run ruff check . && uv run ruff format .`
Expected: clean (format may rewrite; re-run check).

- [ ] **Step 11: Commit**

```bash
git add worker/damwha_worker/ worker/tests/
git commit -m "feat(worker): wire default_speaker_prefix + embedding through dispatch→persist; provisional excluded from identify"
```

---

## Task 4: API speaker rename (`PATCH /speakers/:id`)

**Files:**
- Modify: `src/speakers/speakers.repository.ts`, `src/speakers/speakers.service.ts`, `src/speakers/speakers.controller.ts`
- Test: `test/speakers.e2e-spec.ts`

**Interfaces:**
- Consumes: provisional status (Task 1).
- Produces: `SpeakersRepository.rename(exec, id, name): Promise<SpeakerRow | null>`; `SpeakersService.rename(id, body): Promise<SpeakerRow>`; `PATCH /speakers/:id`. Renames any speaker; promotes `provisional → ready`; other statuses unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/speakers.e2e-spec.ts` inside `describe('speakers', …)`:

```typescript
  it('PATCH /speakers/:id renames; pending stays pending', async () => {
    const created = await request(srv()).post('/speakers').field('name', 'A')
      .attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const res = await request(srv()).patch(`/speakers/${created.body.id}`).send({ name: '새이름' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('새이름');
    expect(res.body.enrollment_status).toBe('pending');
  });

  it('PATCH promotes provisional → ready', async () => {
    const sp = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Speaker_001','provisional') RETURNING id`);
    const res = await request(srv()).patch(`/speakers/${sp.rows[0].id}`).send({ name: '홍길동' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('홍길동');
    expect(res.body.enrollment_status).toBe('ready');
  });

  it('PATCH leaves ready/failed status unchanged', async () => {
    const ready = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('R','ready') RETURNING id`);
    const r1 = await request(srv()).patch(`/speakers/${ready.rows[0].id}`).send({ name: 'R2' });
    expect(r1.body.enrollment_status).toBe('ready');
    const failed = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('F','failed') RETURNING id`);
    const r2 = await request(srv()).patch(`/speakers/${failed.rows[0].id}`).send({ name: 'F2' });
    expect(r2.body.enrollment_status).toBe('failed');
  });

  it('PATCH validation: 404 unknown, 400 bad name', async () => {
    expect((await request(srv()).patch('/speakers/11111111-1111-1111-1111-111111111111').send({ name: 'x' })).status).toBe(404);
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('S') RETURNING id`);
    const id = sp.rows[0].id;
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: '' })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: '   ' })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: 123 })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: 'a'.repeat(101) })).status).toBe(400);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/speakers.e2e-spec.ts`
Expected: FAIL — `PATCH /speakers/:id` returns 404 (route not found) for the rename cases.

- [ ] **Step 3: Add the repository method**

In `src/speakers/speakers.repository.ts`, add to `SpeakersRepository`:

```typescript
  async rename(exec: Queryable, id: string, name: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker
       SET name=$2,
           enrollment_status = CASE WHEN enrollment_status='provisional' THEN 'ready'
                                    ELSE enrollment_status END
       WHERE id=$1 RETURNING *`,
      [id, name],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 4: Add the service method**

In `src/speakers/speakers.service.ts`, add (the class already injects `db` and `speakers`):

```typescript
  async rename(id: string, body: { name?: unknown }) {
    if (typeof body?.name !== 'string') throw new BadRequestException('name must be a string');
    const name = body.name.trim();
    if (!name || name.length > 100) throw new BadRequestException('name must be 1–100 chars');
    const updated = await this.speakers.rename(this.db.pool, id, name);
    if (!updated) throw new NotFoundException('speaker not found');
    return updated;
  }
```

- [ ] **Step 5: Add the controller route**

In `src/speakers/speakers.controller.ts`, add `Patch` to the `@nestjs/common` import, then add:

```typescript
  @Patch(':id')
  @ApiOperation({ summary: '화자 이름 변경 (provisional이면 ready로 확정)' })
  rename(@Param('id', ParseUUIDPipe) id: string, @Body() body: { name?: string }) {
    return this.service.rename(id, body);
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx jest test/speakers.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 7: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.build.json
git add src/speakers/ test/speakers.e2e-spec.ts
git commit -m "feat(api): PATCH /speakers/:id rename + provisional→ready promotion"
```

---

## Task 5: GET meeting utterances include speaker name

**Files:**
- Modify: `src/meetings/meetings.repository.ts:46-52` (`findUtterances`)
- Test: `test/meetings.e2e-spec.ts`

**Interfaces:**
- Produces: `findUtterances` rows gain `speaker_name` (string|null) and `speaker_status` (string|null) via `LEFT JOIN speaker`.

- [ ] **Step 1: Write the failing test**

Append to `test/meetings.e2e-spec.ts` inside its top-level `describe(...)` block (uses the same `srv()`/`db` boilerplate as the other e2e specs):

```typescript
  it('GET /meetings/:id includes speaker_name on utterances', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const sp = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('홍길동','ready') RETURNING id`);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,speaker_id,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'S0',$2,0,1000,'안녕','ok',0,0)`,
      [mid, sp.rows[0].id]);
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances[0].speaker_name).toBe('홍길동');
    expect(res.body.utterances[0].speaker_status).toBe('ready');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/meetings.e2e-spec.ts -t "includes speaker_name"`
Expected: FAIL — `speaker_name` is `undefined`.

- [ ] **Step 3: Add the join**

In `src/meetings/meetings.repository.ts`, replace `findUtterances`:

```typescript
  async findUtterances(exec: Queryable, meetingId: string) {
    const { rows } = await exec.query(
      `SELECT u.*, s.name AS speaker_name, s.enrollment_status AS speaker_status
       FROM utterance u LEFT JOIN speaker s ON s.id = u.speaker_id
       WHERE u.meeting_id=$1 ORDER BY u.order_index ASC`,
      [meetingId],
    );
    return rows;
  }
```

- [ ] **Step 4: Run to verify pass (whole meetings suite — guards against shape-assert regressions)**

Run: `npx jest test/meetings.e2e-spec.ts`
Expected: PASS (new test + existing meeting tests).

- [ ] **Step 5: Commit**

```bash
git add src/meetings/meetings.repository.ts test/meetings.e2e-spec.ts
git commit -m "feat(api): join speaker name/status into GET /meetings/:id utterances"
```

---

## Task 6: Resolve rewrite — provenance, merge, promote, GC, concurrency

**Files:**
- Modify: `src/meetings/meetings.repository.ts` (replace `findClusterInMeeting`, `voiceprintFromClusterCentroid`; add `lockSpeakers`, `createReadySpeaker`, `promoteProvisional`, `deleteOrphanProvisional`)
- Modify: `src/meetings/meetings.service.ts:135-170` (`resolveCluster`)
- Test: `test/clusters.e2e-spec.ts`

**Interfaces:**
- Consumes: migration 004 (Task 1); `loadEnv().EMBEDDING_MODEL`/`EMBEDDING_DIM`; existing `setClusterResolved`, `bulkAssignSpeaker`.
- Produces: resolve semantics per spec §6. Repo methods:
  - `lockClusterInMeeting(exec, meetingId, clusterId)` → `{id, meeting_id, diar_label, resolved_speaker_id, has_centroid} | null` (FOR UPDATE)
  - `lockSpeakers(exec, ids: string[])` → `{id, enrollment_status}[]` (FOR UPDATE, ordered)
  - `createReadySpeaker(exec, name)` → `string`
  - `promoteProvisional(exec, id, name)` → `void`
  - `upsertClusterVoiceprint(exec, clusterId, speakerId, model, dim)` → `void` (ON CONFLICT reattach)
  - `deleteOrphanProvisional(exec, speakerId)` → `boolean`

- [ ] **Step 1: Add a provisional seed helper + write failing tests**

In `test/clusters.e2e-spec.ts`, add a seed helper next to the existing `seed()` and the new tests:

```typescript
  // seed a meeting with an auto-created provisional speaker for one cluster (mirrors persist)
  async function seedProvisional() {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const vec = '[' + Array(192).fill(0.2).join(',') + ']';
    const sp = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Speaker_001','provisional') RETURNING id`);
    const spId = sp.rows[0].id as string;
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,centroid,resolved_speaker_id,processing_version)
       VALUES($1,'SPEAKER_00',$2::vector,$3,0) RETURNING id`, [mid, vec, spId]);
    const cid = c.rows[0].id as string;
    await db.pool.query(
      `INSERT INTO voiceprint(speaker_id,embedding,model,dimension,source,source_cluster_id)
       VALUES($1,$2::vector,'m',192,'auto_cluster',$3)`, [spId, vec, cid]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,speaker_id,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',$2,0,1,0,0),($1,'SPEAKER_00',$2,2,3,1,0)`, [mid, spId]);
    return { mid, clusterId: cid, provisionalId: spId };
  }

  it('merges provisional into existing ready speaker; deletes orphan + reattaches voiceprint', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('김영재','ready') RETURNING id`)).rows[0].id;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(T);
    expect(res.body.updated_utterances).toBe(2);
    expect(res.body.merged_speaker_deleted).toBe(true);
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [provisionalId])).rowCount).toBe(0);
    const vp = await db.pool.query('SELECT speaker_id FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].speaker_id).toBe(T);
    const utt = await db.pool.query('SELECT speaker_id FROM utterance WHERE meeting_id=$1', [mid]);
    expect(utt.rows.every((u) => u.speaker_id === T)).toBe(true);
  });

  it('new_name on a provisional cluster renames+promotes it (no new speaker)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const before = (await db.pool.query('SELECT count(*)::int c FROM speaker')).rows[0].c;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: '박지원' });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(provisionalId);
    expect((await db.pool.query('SELECT count(*)::int c FROM speaker')).rows[0].c).toBe(before);
    const sp = await db.pool.query('SELECT name, enrollment_status FROM speaker WHERE id=$1', [provisionalId]);
    expect(sp.rows[0].name).toBe('박지원');
    expect(sp.rows[0].enrollment_status).toBe('ready');
  });

  it('repeated resolve to same target does not duplicate the cluster voiceprint', async () => {
    const { mid, clusterId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('R','ready') RETURNING id`)).rows[0].id;
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    const vp = await db.pool.query('SELECT count(*)::int c FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows[0].c).toBe(1);
  });

  it('reassign ready A → ready B moves voiceprint to B and keeps A', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'A' }); // promote → ready
    const B = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('B','ready') RETURNING id`)).rows[0].id;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: B });
    expect(res.status).toBe(200);
    expect(res.body.merged_speaker_deleted).toBe(false);
    expect((await db.pool.query('SELECT enrollment_status FROM speaker WHERE id=$1', [provisionalId])).rows[0].enrollment_status).toBe('ready');
    const vp = await db.pool.query('SELECT speaker_id FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].speaker_id).toBe(B);
  });

  it('rejects bad resolve inputs (both / malformed uuid / pending target)', async () => {
    const { mid, clusterId } = await seedProvisional();
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: '00000000-0000-0000-0000-000000000000', new_name: 'x' })).status).toBe(400);
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: 'not-a-uuid' })).status).toBe(400);
    const pend = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('P','pending') RETURNING id`)).rows[0].id;
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: pend })).status).toBe(409);
  });

  it('404 when speaker_id is a valid but unknown UUID', async () => {
    const { mid, clusterId } = await seedProvisional();
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(404);
  });

  it('409 on new_name when cluster already resolved to a ready speaker', async () => {
    const { mid, clusterId } = await seedProvisional();
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'A' });
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'B' });
    expect(res.status).toBe(409);
  });

  it('concurrent PATCH(promote) and resolve(merge) end consistently (no torn state)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('T','ready') RETURNING id`)).rows[0].id;
    await Promise.allSettled([
      request(srv()).patch(`/speakers/${provisionalId}`).send({ name: 'Named' }),
      request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T }),
    ]);
    expect((await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [clusterId])).rows[0].resolved_speaker_id).toBe(T);
    const vp = await db.pool.query('SELECT count(*)::int c FROM voiceprint WHERE source_cluster_id=$1 AND speaker_id=$2', [clusterId, T]);
    expect(vp.rows[0].c).toBe(1);
    const a = await db.pool.query('SELECT enrollment_status FROM speaker WHERE id=$1', [provisionalId]);
    if (a.rowCount === 1) expect(a.rows[0].enrollment_status).toBe('ready'); // patch-first; never still provisional
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest test/clusters.e2e-spec.ts`
Expected: FAIL — current resolve creates a new speaker on `new_name` even for provisional clusters; no `merged_speaker_deleted`; duplicate voiceprints; no 409/400 for the new matrix.

- [ ] **Step 3: Replace/add repository methods**

In `src/meetings/meetings.repository.ts`, **replace** `findClusterInMeeting` with a locking version and **replace** `voiceprintFromClusterCentroid` with the upsert, and add the new methods:

```typescript
  async lockClusterInMeeting(exec: Queryable, meetingId: string, clusterId: string) {
    const { rows } = await exec.query(
      `SELECT id, meeting_id, diar_label, resolved_speaker_id, (centroid IS NOT NULL) AS has_centroid
       FROM meeting_cluster WHERE id=$1 AND meeting_id=$2 FOR UPDATE`,
      [clusterId, meetingId],
    );
    return rows[0] ?? null;
  }

  async lockSpeakers(
    exec: Queryable,
    ids: string[],
  ): Promise<{ id: string; enrollment_status: string }[]> {
    if (ids.length === 0) return [];
    const { rows } = await exec.query<{ id: string; enrollment_status: string }>(
      `SELECT id, enrollment_status FROM speaker WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    return rows;
  }

  async createReadySpeaker(exec: Queryable, name: string): Promise<string> {
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO speaker(name, enrollment_status) VALUES($1,'ready') RETURNING id`,
      [name],
    );
    return rows[0].id;
  }

  async promoteProvisional(exec: Queryable, id: string, name: string): Promise<void> {
    await exec.query(
      `UPDATE speaker SET name=$2, enrollment_status='ready'
       WHERE id=$1 AND enrollment_status='provisional'`,
      [id, name],
    );
  }

  // reattach (or insert) the single cluster-derived voiceprint to the final speaker (idempotent)
  async upsertClusterVoiceprint(
    exec: Queryable, clusterId: string, speakerId: string, model: string, dimension: number,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source, source_cluster_id)
       SELECT $2, centroid, $3, $4, 'cluster_resolve', id
       FROM meeting_cluster WHERE id=$1 AND centroid IS NOT NULL
       ON CONFLICT (source_cluster_id) WHERE source_cluster_id IS NOT NULL
       DO UPDATE SET speaker_id = EXCLUDED.speaker_id`,
      [clusterId, speakerId, model, dimension],
    );
  }

  async deleteOrphanProvisional(exec: Queryable, speakerId: string): Promise<boolean> {
    const res = await exec.query(
      `DELETE FROM speaker s
       WHERE s.id=$1 AND s.enrollment_status='provisional'
         AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id=s.id)
         AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id=s.id)`,
      [speakerId],
    );
    return (res.rowCount ?? 0) > 0;
  }
```

(Keep `setClusterResolved` and `bulkAssignSpeaker` as-is.)

- [ ] **Step 4: Rewrite `resolveCluster` in the service**

In `src/meetings/meetings.service.ts`, add a UUID regex constant near the top (after the `AUDIO_MIME` const):

```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

Replace the entire `resolveCluster` method with:

```typescript
  async resolveCluster(
    meetingId: string,
    clusterId: string,
    body: { speaker_id?: string; new_name?: string },
  ): Promise<{ speaker_id: string; updated_utterances: number; merged_speaker_deleted: boolean }> {
    const hasId = body.speaker_id !== undefined && body.speaker_id !== null;
    const hasName = body.new_name !== undefined && body.new_name !== null;
    if (hasId === hasName) {
      throw new BadRequestException('exactly one of speaker_id or new_name required');
    }
    let newName: string | undefined;
    if (hasName) {
      if (typeof body.new_name !== 'string') throw new BadRequestException('new_name must be a string');
      newName = body.new_name.trim();
      if (!newName || newName.length > 100) throw new BadRequestException('new_name must be 1–100 chars');
    }
    if (hasId && !UUID_RE.test(String(body.speaker_id))) {
      throw new BadRequestException('speaker_id must be a UUID');
    }

    const env = loadEnv();
    return this.db.withTransaction(async (c) => {
      const cluster = await this.meetings.lockClusterInMeeting(c, meetingId, clusterId);
      if (!cluster) throw new NotFoundException('cluster not found in meeting');
      const sPrev: string | null = cluster.resolved_speaker_id;

      // lock S_prev and T (ordered by id) to serialize with PATCH /speakers/:id
      const lockIds = [sPrev, hasId ? (body.speaker_id as string) : null].filter(Boolean) as string[];
      const locked = await this.meetings.lockSpeakers(c, lockIds);
      const statusOf = (id: string | null) =>
        id ? (locked.find((r) => r.id === id)?.enrollment_status ?? null) : null;

      let finalSpeakerId: string;
      if (hasId) {
        const T = body.speaker_id as string;
        if (!locked.some((r) => r.id === T)) throw new NotFoundException('speaker not found');
        const tStatus = statusOf(T);
        if (tStatus === 'pending' || tStatus === 'failed') {
          throw new ConflictException('cannot merge into a pending/failed speaker');
        }
        finalSpeakerId = T;
      } else {
        const prevStatus = statusOf(sPrev);
        if (sPrev && prevStatus === 'provisional') {
          await this.meetings.promoteProvisional(c, sPrev, newName as string);
          finalSpeakerId = sPrev;
        } else if (sPrev === null) {
          finalSpeakerId = await this.meetings.createReadySpeaker(c, newName as string);
        } else {
          throw new ConflictException(
            'cluster already resolved; use PATCH /speakers/:id to rename or provide speaker_id to merge',
          );
        }
      }

      // unified bulk assign → updated_utterances = utterance count for this diar_label
      const updated = await this.meetings.bulkAssignSpeaker(c, meetingId, cluster.diar_label, finalSpeakerId);
      await this.meetings.setClusterResolved(c, clusterId, finalSpeakerId);
      if (cluster.has_centroid) {
        await this.meetings.upsertClusterVoiceprint(c, clusterId, finalSpeakerId, env.EMBEDDING_MODEL, env.EMBEDDING_DIM);
      }
      let mergedDeleted = false;
      if (sPrev && sPrev !== finalSpeakerId) {
        mergedDeleted = await this.meetings.deleteOrphanProvisional(c, sPrev);
      }
      return { speaker_id: finalSpeakerId, updated_utterances: updated, merged_speaker_deleted: mergedDeleted };
    });
  }
```

(`BadRequestException`, `ConflictException`, `NotFoundException` are already imported at the top of the file.)

- [ ] **Step 5: Run to verify pass (whole cluster suite — existing legacy tests must stay green)**

Run: `npx jest test/clusters.e2e-spec.ts`
Expected: PASS — new provisional tests + existing legacy tests (`resolves to a NEW speaker`, `resolves to an EXISTING speaker`, 404, 400) still green (they seed `resolved_speaker_id=NULL` clusters → legacy create/merge paths).

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.build.json
git add src/meetings/meetings.repository.ts src/meetings/meetings.service.ts test/clusters.e2e-spec.ts
git commit -m "feat(api): resolve rewrite — provenance reattach, provisional merge/promote, orphan GC, lock serialization"
```

---

## Task 7: Update CLAUDE.md invariant + run full suites

**Files:**
- Modify: `CLAUDE.md` (speaker identification invariant bullet)

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Update the invariant bullet**

In `CLAUDE.md`, find the bullet under "Non-obvious invariants" beginning **"Speaker identification (`voiceprint`)"**. Replace the sentence:

> *"Unidentified speakers are preserved as `meeting_cluster` rows (raw `diar_label`), never force-created as `speaker`."*

with:

> Unidentified speakers are **auto-created as `provisional` speakers** (default name `Speaker_NNN` via `speaker_default_seq`) with an `auto_cluster` voiceprint carrying `source_cluster_id` provenance. `provisional` speakers are **excluded from identification** (it filters `enrollment_status='ready'`) until confirmed by rename (`PATCH /speakers/:id` promotes `provisional→ready`). `meeting_cluster` rows are retained as the per-meeting `diar_label→speaker` record; `resolve` reattaches the cluster's single voiceprint (`ON CONFLICT (source_cluster_id)`) and GCs orphaned provisional speakers.

- [ ] **Step 2: Run the full API suite**

Run: `nvm use && npm test`
Expected: PASS (all Jest suites).

- [ ] **Step 3: Run the full worker suite + lint**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS + clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update speaker identification invariant for provisional auto-enrollment"
```

---

## Self-Review

**Spec coverage** (spec §→task):
- §3 migration (provisional/seq/source_cluster_id/index) → Task 1 ✓
- §4 worker persist auto-create, centroid-None path, guards → Task 2 ✓
- §4.3 config validator + dispatch→run→persist wiring → Task 3 ✓
- §5 identify excludes provisional → Task 3 (regression test) ✓
- §6.1 cluster+speaker lock → Task 6 (lockClusterInMeeting/lockSpeakers) ✓
- §6.2 input validation (one-of / new_name / uuid) → Task 6 ✓
- §6.3 matrix (T pending/failed 409; S_prev provisional/null/ready) → Task 6 ✓
- §6.5 UPSERT reattach (predicate) → Task 6 (upsertClusterVoiceprint) ✓
- §6.6 orphan conditional DELETE → Task 6 (deleteOrphanProvisional) ✓
- §6.7 unified bulk assign → updated_utterances → Task 6 ✓
- §7 PATCH rename + promotion → Task 4 ✓
- §8 GET utterance speaker join → Task 5 ✓
- §9.1 seq gaps / name not unique → documented (spec); reset hygiene in Tasks 1/2 ✓
- §9.3 sequence reset in test helpers → Tasks 1 & 2 ✓
- §10 tests (migration/worker/api incl. concurrency) → Tasks 1–6 ✓
- §2 invariant doc → Task 7 ✓

**Type consistency:** repo method names used by the service in Task 6 (`lockClusterInMeeting`, `lockSpeakers`, `createReadySpeaker`, `promoteProvisional`, `upsertClusterVoiceprint`, `deleteOrphanProvisional`, plus kept `setClusterResolved`/`bulkAssignSpeaker`) all defined in Task 6 Step 3. Worker `persist_process_meeting` kwargs (`embedding_model`, `embedding_dim`, `default_speaker_prefix`) defined in Task 2 and consumed in Task 3. `default_speaker_prefix` threads config→dispatch→handle_job→run_process_meeting→persist consistently.

**Placeholder scan:** none — every code/test step shows full content; commands have expected outcomes.
