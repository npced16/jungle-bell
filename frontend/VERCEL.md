# Vercel 웹 배포

운영 웹 origin은 `https://jungle-bell.sijun-yang.com`을 유지한다. Vercel은 정적 React/PWA를 제공하고
`/api/*`를 Supabase의 `api` Edge Function으로 내부 rewrite한다. API 인증과 Worker 실행은 Supabase가 담당한다.

## 프로젝트 준비

Vercel 프로젝트의 Root Directory는 `frontend`, Node.js는 저장소와 같은 24.x로 설정한다.
Supabase 프로젝트를 실제 생성한 뒤 확인된 project ref로 **배포 전에** 설정을 생성한다.

```powershell
node scripts/vercel-config.mjs create <confirmed-project-ref>
node scripts/vercel-config.mjs check
npm run verify:web
```

`create`는 기존 `vercel.json`을 덮어쓰지 않는다. 프로젝트를 변경할 때는 기존 설정을 검토하고
목적지만 수정한 뒤 `check`를 실행한다. 생성된 `vercel.json`은 리뷰하고 버전 관리한다.
Vercel이 빌드 명령보다 먼저 설정을 읽으므로 설정 생성 명령을 build script에 넣지 않는다.
API 함수명은 `api`, upstream 경로는 `/functions/v1/api/api/:path*`다.
project ref는 공개 식별자이며 키가 아니다. 웹 배포에는 Supabase secret/service-role 키가 필요 없다.

`npm ci`, `npm run build:web`, `dist/web`을 설정 파일에서 지정한다. Hash routing을 사용하므로
SPA catch-all rewrite를 추가하지 않는다. API 404와 오류 응답이 index.html로 바뀌면 안 된다.
Vercel Node Function proxy를 추가하면 자산 body 크기 제한이 달라질 수 있으므로 외부 rewrite를 유지한다.

## 인증과 캐시 경계

API rewrite는 destination을 고정한다. 요청 header, query 또는 사용자 입력으로 목적지를 선택하지 않는다.
Supabase는 공개 origin을 서버 설정으로 지정하고 `Host`, `Forwarded`, `X-Forwarded-Host`를
그대로 신뢰하여 pairing/asset URL을 생성하지 않는다. Origin 허용 목록은 운영 웹 및 명시한 개발 origin만
포함한다. Preview origin에서 인증 검증이 필요하면 해당 origin을 명시적으로 추가하고 작업 후 제거한다.

기존 bearer와 cookie 인증을 유지한다. Supabase JWT 검증 대신 API 함수 내부에서 기존 토큰을 검증해야 한다.
API의 `Origin`, `Authorization`, `Cookie`, HTTP method/body/query와 응답 status, ETag, CORS,
복수 `Set-Cookie`가 보존되어야 한다. 쿠키는 Secure/HttpOnly/SameSite=Strict/Path=/와 무 Domain 속성을 유지한다.
Vercel 인증 보호 화면은 데스크톱 API 요청을 가로막을 수 있으므로 실제 사용 가능한 검증 환경을 준비한다.

`x-vercel-enable-rewrite-caching: 0`으로 모든 API의 Vercel CDN 캐시를 끈다.
개인 API와 pairing/usage 응답의 `Cache-Control: no-store`는 서버에서 계속 반환한다.
공개 데이터/immutable image의 브라우저 캐시 헤더는 덮어쓰지 않아 기존 PWA 캐시가 유지된다.
`sw.js`와 manifest는 재검증한다. 별도 Supabase Storage URL로 redirect하지 말고 기존
`/api/public/assets/{sha}.{extension}` URL에서 이미지 body를 반환한다.

## 로컬 Supabase 연결

```powershell
$env:JUNGLE_BELL_DEV_API_ORIGIN = 'http://127.0.0.1:54321'
$env:JUNGLE_BELL_DEV_API_PREFIX = '/functions/v1/api'
npm run dev:web
```

원격 Supabase를 직접 개발 proxy로 사용할 때는 origin만 `https://<confirmed-project-ref>.supabase.co`로 바꾼다.
개발 prefix는 고정된 `/functions/v1/api`만 허용하며 API 경로와 query는 그대로 덧붙인다.
Supabase 연결 모드에서 Vite는 브라우저 Origin을 바꾸지 않는다. 서버가 해당 로컬 origin을 명시적으로 허용해야 한다.
production HTTPS Secure 쿠키와 설치 PWA 동작은 로컬 HTTP 확인으로 대신할 수 없다.
기존 운영 API에 연결하려면 prefix 환경변수를 제거한다.

## 배포 후 확인과 전환

로컬 설정 테스트는 Vercel의 실제 헤더 전달을 증명하지 않는다. DNS 전환 전 staged 배포에서 아래를 확인한다.

- 공개 status/laundry/meals 및 month query, 이미지 body/Content-Type/ETag, API 404/오류 JSON.
- bearer 요청의 인증 성공과 만료 실패, 허용/금지 Origin 및 OPTIONS, 무인증 개인 요청 거부.
- QR handoff와 pending cookie의 복수 Set-Cookie 보존, 설치 PWA claim, PC 승인, complete와 session cookie 재전송.
- 쿠키 삭제와 연결 해제, 개인 응답 no-store, 반복 요청에 CDN HIT가 없고 다른 사용자 응답이 섞이지 않음.
- Push 구독/수신/알림 클릭, 공개 데이터 오프라인 화면, 개인 데이터 비캐시, 새 SW 업데이트.
- 30x 없는 API 응답과 기존 도메인 absolute asset URL. preview의 이미지 검증은 운영 origin 불일치에 유의한다.

계정/로그인/실제 기기 준비가 필요한 검증은 메인을 통해 사용자와 조율한다.
기존 도메인을 유지해도 DB/token 해시 및 VAPID 키를 옮기지 않으면 기존 session과 Push 구독이 유지되지 않는다.
도메인 연결/DNS 변경은 데이터 이관과 위 검증을 완료한 뒤 수행한다.

근거: [Vercel external rewrites와 캐시](https://vercel.com/docs/routing/rewrites),
[Supabase 함수 인증 설정](https://supabase.com/docs/guides/functions/function-configuration).
