# Jungle Bell

> **임시 운영 중**
>
> 현재 세탁실과 급식 정보를 웹에서 임시로 제공합니다.
> **[웹사이트 열기](https://jungle-bell.vercel.app)**

<p align="center">
  <img src="docs/assets/readme/logo.png" width="96" alt="Jungle Bell">
</p>

크래프톤 정글의 공개 생활 정보를 로그인 없이 확인하는 웹사이트입니다.
현재 운영 저장소는 [npced16/jungle-bell](https://github.com/npced16/jungle-bell)입니다.

## 현재 제공하는 화면

- **홈 세탁실:** 워시타워 번호별 세탁기·건조기 상태와 남은 시간을 세탁실 화면과 같은 상태표로 표시합니다.
- **홈 오늘 급식:** 오늘 중식·석식의 사진과 본문을 표시합니다. 아직 게시되지 않은 식사는 카드 틀과 식사 구분을 유지하고 사진 영역을 비워 둡니다. 지난 메뉴를 오늘 메뉴 대신 표시하지 않습니다.
- **급식 게시물:** 카카오채널의 주간 식단표·중식·석식·기타 게시물을 구분하고, 저장된 사진·본문·원문 링크를 제공합니다.
- **세탁실 상세:** 기기별 상태와 수집 상태를 확인할 수 있습니다. 수집이 지연되거나 실패하면 마지막 확인 상태와 안내를 표시합니다.

현재 서비스는 **웹만 운영**합니다. 앱 설치·출석·개인 알림·앱 릴리즈 배포는 현재 제공 범위에 포함하지 않습니다. 웹의 새 버전 알림도 표시하지 않으며, 변경 사항은 새 방문이나 새로고침으로 반영됩니다.

## 데이터와 운영 구조

- 웹 화면은 **Vercel**에서 제공합니다.
- 공개 데이터 API와 수집 작업은 **Supabase Edge Functions**, 저장소는 **Supabase 데이터베이스**를 사용합니다.
- 급식은 [카카오채널 게시물](https://pf.kakao.com/_xhzNjn/posts)을 **5분 간격**으로 수집해 게시물과 이미지 정보를 저장합니다. 사진에 없는 메뉴를 생성하거나 추정하지 않습니다.
- 화면의 정보는 수집 시점 기준이며 원본 게시나 기기 상태 변경이 즉시 반영되지 않을 수 있습니다.

저장소에는 이전 PC·PWA 및 서버 구현도 남아 있습니다. 이 코드는 보존된 개발 자산이며, 현재 웹 서비스에서 해당 기능을 운영한다는 뜻은 아닙니다.

## 피드백

[버그 제보](https://github.com/npced16/jungle-bell/issues/new?template=bug.yml) · [기능 개선 및 피드백](https://github.com/npced16/jungle-bell/issues/new?template=feature_request.yml) · [질문](https://github.com/npced16/jungle-bell/issues/new?template=question.yml)

공개 이슈에 개인정보나 인증 정보를 올리지 마세요. Jungle Bell은 크래프톤 정글의 공식 서비스가 아닙니다.

## 개인정보 처리방침

[웹에서 확인하기](https://jungle-bell.vercel.app/#/privacy)

## 개발과 원 프로젝트

개발 방법은 [기여 안내](CONTRIBUTING.md)를 참고하세요. 기존 플랫폼 문서에는 현재 운영 범위 밖의 기능도 설명되어 있습니다.

이 저장소는 [YangSiJun528/jungle-bell](https://github.com/YangSiJun528/jungle-bell)을 바탕으로 현재 웹 운영에 맞게 변경한 프로젝트입니다. 원 프로젝트의 저작권과 기여를 존중하며, 원저자를 현재 임시 서비스의 운영자로 표시하지 않습니다. 원 프로젝트의 시작과 발전 과정은 [개발 여정](journey.md)에 보존되어 있습니다.

## 라이선스

[Apache License 2.0](LICENSE). 원 프로젝트의 라이선스와 저작권 고지를 유지합니다.
