# Supabase 이전 후보

기존 Spring API·Worker를 대체하는 후보 구현입니다. 배포, 실제 데이터 이전, DNS 전환,
Cron 실행, PC/PWA·OS 알림 확인을 끝내기 전에는 기존 서버를 종료하지 않습니다.
Spring 코드는 전환 및 rollback 기간 동안 유지합니다.

## 구조와 계약

- Vercel은 정적 웹과 `/api/*` 외부 rewrite를 제공합니다.
- 목적지는 `https://<ref>.supabase.co/functions/v1/api/api/*`입니다. handler는
  `/api/*`, `/api/api/*`, `/functions/v1/api/api/*`를 같은 경로로 해석합니다.
- API는 기존 opaque `jbd_`, `jbui_`, `jbs_`와 token hash를 검증합니다. Supabase Auth
  로그인이나 클라이언트 service-role key를 도입하지 않습니다. `verify_jwt=false`는
  이 기존 인증을 함수 안에서 수행하기 위한 설정입니다.
- `jb` private schema의 28개 table을 사용합니다. `anon`·`authenticated`에는 schema/table
  접근을 허용하지 않고 RLS도 활성화합니다. SQL은 모든 table을 `jb.`로 한정합니다.
- `JB_DATABASE_URL` 또는 hosted 기본 `SUPABASE_DB_URL`로 서버에서만 DB에 연결합니다.
  transaction pooler 사용을 지원하며 prepared statement/session search_path에 의존하지 않습니다.
- WebView exact origin, 부모 session 폐기·만료, JSON unknown field 거부, 계정 소유권,
  Strict/HttpOnly/Secure 쿠키, 사용량 수집 gate를 유지합니다. 쿠키 변경 요청은 고정 공개
  origin을 요구합니다. preview 도메인을 자동 허용하지 않습니다.
- 오류는 기존 코드의 실제 DTO인 `{ "error": "CODE", "issues": null }`를 반환합니다.
  모든 응답에 `X-Request-ID`, 개인 응답에 `no-store`를 적용합니다.
- 공개 자산은 계속 공식 origin의 `/api/public/assets/{sha}.{extension}`입니다.

## 로컬 검사

Deno 2.9.6을 사용합니다. PATH에 없다면 `npm exec --yes --package=deno@2.9.6 -- deno`
명령으로 실행할 수 있습니다. `server/supabase`에서 실행합니다.

```sh
deno task check
deno task test
```

통합 테스트는 **전용** `jungle_bell_test` 로컬 PostgreSQL DB가 필요합니다.
`JB_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/jungle_bell_test`를 설정한 뒤:

```sh
deno task test:integration
```

이 명령은 테스트 DB의 `jb` schema를 새로 만듭니다. 운영 URL은 사용하지 않습니다.
환경변수가 없으면 실패하며 테스트를 건너뛰지 않습니다. CI는 PostgreSQL 17 service로
같은 테스트를 실행합니다. CI 자체의 성공 여부는 실제 실행 결과로 별도 확인합니다.

PostgreSQL이 없는 환경에서는 `JB_TEST_PGLITE=true`를 명시해 같은 migration 원문과
parameter SQL을 PostgreSQL WASM(PGlite)에서 실행할 수 있습니다. 이는 SQL/트랜잭션
검증이며 독립 connection의 lock 경합, hosted pooler, Supabase gateway 검증은 아닙니다.
auth/storage/pg_net/cron 등 Supabase 플랫폼 서비스도 재현하지 않습니다.

## 배포 준비

1. 새 전용 프로젝트에 `migrations/`를 순서대로 적용합니다. migration은 Cron을 켜지 않습니다.
2. `.env.example`의 비밀과 source 설정을 Edge secrets로 전달합니다. 비밀을 콘솔·Git·VITE 변수에
   넣지 않습니다. 기존 pairing/usage/VAPID 키는 원본을 안전하게 이전해야 합니다.
3. `api`, `collect-laundry`, `collect-meals`, `automate`, `push`를 배포합니다. 배포 도구가
   `config.toml`을 읽지 않으면 각 함수의 JWT 검증 비활성화를 명시합니다.
4. Collector는 `COLLECTORS_ENABLED=false`로 시작합니다. 공개 조회는 source가 없으면
   `NO_DATA`를 반환하며 성공한 것처럼 가짜 데이터를 만들지 않습니다.
5. Vercel의 공식 도메인은 기존 `https://jungle-bell.sijun-yang.com`을 유지합니다.
   30x redirect 대신 내부 rewrite를 사용하고 Authorization, Origin, Cookie 및 복수
   Set-Cookie를 보존합니다. 원격 직접 Edge 호출과 Vercel 호출 모두 IP rate-limit
   header의 실제 신뢰 경계를 검증해야 합니다. 프록시 공용 IP가 모든 사용자에게
   같은 rate key로 쓰이거나 사용자 입력 header로 우회되는 상태는 cutover 불가입니다.

필수 비밀이 없으면 API 설정 초기화가 실패합니다. 기본 키나 개발용 고정 키로
운영 인증을 대체하지 않습니다. secret 주입 없는 배포 성공은 API 운영 가능성 증거가 아닙니다.

## 데이터 이전과 cutover

1. 기존 PostgreSQL을 백업하고 복구 가능성을 확인합니다. 데이터를 유지할지 재등록할지
   사용자 결정을 먼저 확정합니다. 원본 backup/secret은 저장소 밖에서만 보관합니다.
2. 전환 시간을 정한 뒤 기존 API 쓰기와 Worker를 일시 중지합니다. 새 Cron은 아직 꺼둡니다.
   읽기만 동작하는 두 collector가 동시에 이벤트를 생성하게 두지 않습니다.
3. 신규 `jb` table이 모두 빈 상태에서 `JB_SOURCE_DATABASE_URL`(기존 `public`)과
   `JB_TARGET_DATABASE_URL`(신규 `jb`)을 안전하게 설정하고 아래 명령을 실행합니다.

   ```sh
   deno run --allow-env --allow-net operations/transfer-data.ts --confirm-source-writers-paused
   ```

   도구는 28 table allowlist만 복사합니다. source repeatable-read snapshot, target 단일
   transaction, 컬럼·타입 일치, 행 수, 이미지 SHA 검사를 사용합니다. 대상이 비어 있지 않으면
   중지하며 기존 데이터를 덮거나 Supabase 관리 schema를 삭제하지 않습니다. 원자료·설정·기기
   자격 증명은 유지하고 실행 중 lease/cursor만 해제합니다. 실패 시 대상 transaction은 rollback됩니다.
4. 테이블별 건수와 이미지 SHA, token hash/만료·부모 관계, FK, 실제 기존 PC·PWA 접근을 대조합니다.
   이 도구의 count 출력만으로 서비스 호환 검증을 완료하지 않습니다.
5. Vault에 `jb_project_url`, `jb_job_secret`을 설정합니다. JOB_SECRET과 Vault 값이 같아야 합니다.
   source GET 및 Push 테스트가 끝난 뒤 `operations/activate-jobs.sql`을 실행합니다.
   `USAGE_METRICS_ENABLED=false`인 경우 hourly SQL 인자도 false로 일치시킵니다.
6. 새 API·Cron이 정상임을 확인하고 DNS/프록시를 전환합니다. PC 등록/rotate/heartbeat/출석,
   WebView UI, PWA pairing/Push/해제, 기존 credential, 급식 이미지, 세탁 알림을 실제 검증합니다.
7. 기존 프로세스를 정지한 상태에서도 새 수집·알림·정리 성공을 관찰한 뒤에만 이전 완료로 판단합니다.
   롤백 시 새 쓰기를 먼저 멈추고 데이터 역동기화 여부를 결정합니다. 전환 후 쓰기가 생긴 상태에서
   단순히 옛 DB로 되돌리면 데이터가 유실됩니다. `deactivate-jobs.sql`은 이 앱 job만 비활성화합니다.

**외부 source 주의:** `LAUNDRY_SOURCE_URL`의 LG ThinQ 수집 서버는 이 저장소에 없습니다.
`tools/campus-observer`는 LMS 번들 분석 CLI입니다. 해당 source가 종료 대상 머신에서
돌고 있다면 source도 별도 이전하기 전에는 머신을 종료할 수 없습니다.

## 스케줄과 운영 확인

- 세탁: 1분, 급식: 5분, 자동화: 1분.
- 급식/자동화 10초 continuation은 DB cursor가 있을 때만 Edge 호출합니다.
- Push 5초 검사도 만기 전 pending/retry delivery가 있고 lease가 만료된 경우만 호출합니다.
- 사용량 집계/보존기간 삭제: 매시 7분. 실패 시 transaction 전체가 rollback되어 재시도 가능합니다.
- 기본 호출량은 30일 기준 세탁 43,200 + 급식 8,640 + 자동화 43,200회이며 continuation과
  Push 및 사용자 API 호출은 별도입니다. Free 할당량/요금은 배포 시 계정에서 확인합니다.
- `cron.job_run_details`는 dispatch SQL 성공만 보여줍니다. `net._http_response`의 HTTP 결과,
  Edge logs, `source_state`, `maintenance_state`, `notification_delivery`를 함께 확인해야 합니다.
- 성공 기준은 source 최근 성공, cursor가 계속 진행되고 소진됨, delivery의 retry/gone/delivered가
  올바름, `usage-daily-summary-v1:success`가 갱신됨입니다. `/api/health` 성공만으로 대체하지 않습니다.
- Spring Actuator는 이식하지 않습니다. 운영 정보는 Supabase 인증된 SQL/Logs에서 확인하며
  공개 `/actuator/*` endpoint를 만들지 않습니다.

공식 참고: [Edge 제한](https://supabase.com/docs/guides/functions/limits),
[서버 DB 연결](https://supabase.com/docs/guides/functions/connect-to-postgres),
[JWT gateway](https://supabase.com/docs/guides/functions/auth-headers),
[Cron](https://supabase.com/docs/guides/cron),
[Vault 예약 호출](https://supabase.com/docs/guides/functions/schedule-functions).
# 일일 급식 데이터 보관

중식과 석식 메뉴는 식사일 다음 날 한국 시간 자정에 만료됩니다. 제목(없으면 본문 첫 유효 줄)에
명시한 월·일을 사용하고, 명시된 날짜가 없으면 게시 시각(없으면 최초 수집 시각)의 한국 날짜를
사용합니다. `jb-daily-meal-retention`이 매분 만료 게시물을 정리하므로
삭제는 만료 후 다음 실행 시점에 이루어집니다. 게시물과 연결 이미지 메타데이터를 삭제하고,
삭제된 게시물에 연결됐던 이미지 중 다른 게시물에서 참조하지 않는 `meal_asset.content` BYTEA도 삭제합니다. 주간표·기타
게시물과 그 게시물이 공유하는 이미지는 유지합니다.

기존에 이미 만료된 중식·석식도 예약 작업을 활성화한 후 첫 실행에서 정리합니다. 재수집으로 되살아나지
않도록 수집 전에 만료 여부를 판정하고 DB 쓰기에도 동일 제한을 둡니다. 재삽입 방지용
게시물 ID·만료 시각만 `maintenance_state`의 `retention:daily:` 항목으로 남기며 본문이나
이미지 바이트는 남기지 않습니다. 원본 채널과 이미 내려받은 브라우저 캐시, DB 백업은
이 정책의 삭제 대상이 아닙니다. PostgreSQL 파일 크기는 행 삭제 직후 줄어들지 않을 수
있으며 삭제된 공간은 VACUUM 이후 재사용됩니다.

## Cron 실행 기록 보관

`jb-cron-history-retention`은 매시 00·15·30·45분에
프로젝트 전체 `cron.job_run_details`에서 종료 후 72시간이 지난 기록만 삭제합니다.
실행 중인 작업과 작업 정의·예약은 유지합니다. 최초 정리가 필요하면 아래 SQL을 한 번 실행합니다.

```sql
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '72 hours';
```

삭제 후 PostgreSQL이 공간을 재사용할 수 있지만 대시보드의 디스크 사용량이 즉시 줄어들지는 않을 수 있습니다.

