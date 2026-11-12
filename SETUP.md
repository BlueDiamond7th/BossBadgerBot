# 환경 설정과 명령어 등록 오류

`.env`는 `run.command`와 같은 폴더에 있는 설정 파일입니다. `.env.example`은 예시이며 실제 실행은 `.env`를 읽습니다. 기존 `.env`가 있으면 예시로 덮어쓰지 마세요. 파일명이 `.env.txt`가 아닌지 확인하세요.

```dotenv
DISCORD_TOKEN=여기에_실제_봇_토큰
DISCORD_APPLICATION_ID=여기에_숫자로_된_Application_ID
DISCORD_GUILD_ID=여기에_숫자로_된_서버_ID
DATABASE_PATH=./data/bot.sqlite
```

위 값은 설명용이며 실제 값으로 바꿔야 합니다. 한 줄에 하나씩 입력하고 저장하세요.

| 항목 | 찾는 위치 | 주의점 |
|---|---|---|
| DISCORD_TOKEN | Discord Developer Portal → 사용할 앱 → Bot → 토큰 발급/Reset Token | Bot 토큰 원문만 입력. Client Secret·Public Key·개인 계정 토큰과 다릅니다. `Bot ` 접두어를 붙이지 않습니다. 재발급하면 이전 토큰은 무효가 됩니다. |
| DISCORD_APPLICATION_ID | 같은 앱 → General Information → Application ID | 숫자 ID. 토큰을 가져온 앱과 반드시 같아야 합니다. |
| DISCORD_GUILD_ID | Discord 사용자 설정 → 고급 → 개발자 모드 활성화 → 왼쪽 서버 아이콘 우클릭 → 서버 ID 복사 | 봇을 설치할 디스코드 서버의 ID. 채널·스레드·사용자 ID와 다릅니다. |
| DATABASE_PATH | 직접 지정하는 로컬 파일 경로 | 기본값 유지 가능. 등록 단계에서는 DB에 접속하지 않으므로 이 경로는 Discord 명령어 등록 실패와 무관합니다. |

봇 토큰은 비밀번호처럼 다루고 채팅에 붙여 넣지 마세요. 이미 터미널 환경변수로 같은 이름을 설정했다면 Node는 `.env`보다 그 값을 우선 사용합니다. 오래된 값을 export해 둔 경우 새 터미널 또는 해당 변수 unset 후 실행하세요.

## 실행 순서

1. `.env` 저장.
2. `./run.command invite` 실행. 링크를 열어 원하는 서버에 `bot`과 `applications.commands` 범위를 승인합니다. 서버 설치 권한이 있는 계정이 필요합니다.
3. `./run.command register` 실행. 성공하면 `/보스방`, `/캐릭터`, `/파티` 등록 메시지가 표시됩니다.
4. `./run.command start` 실행. 봇 연결 완료 후 스레드에서 사용합니다.

`register`는 명령어 목록을 Discord에 등록하는 작업입니다. 봇을 계속 실행시키는 작업은 `start`입니다. 등록할 때 봇이 온라인일 필요는 없지만 서버에 앱을 먼저 승인해야 합니다.

## 기존 오류 문구의 의미

`명령어 등록 실패. 토큰·앱 ID·서버 ID를 확인해 주세요.`는 Discord 원문이 아니라 이전 코드가 여러 오류를 하나로 합친 안내입니다. 이 문구만으로 토큰 오류라고 확정할 수 없습니다.

설정 검사는 필수값 존재와 두 ID가 17~20자리 숫자인지만 확인합니다. 따라서 일반 실패 문구가 나왔다면 보통 그 형식 검사는 통과했지만 인증·권한·요청·연결 단계에서 실패한 것입니다. 숫자로 된 잘못된 채널 ID도 형식 검사를 통과할 수 있습니다.

또 이전 버전은 등록 성공 후에만 초대 링크를 출력했습니다. 처음 설치하면서 안내 순서를 그대로 따랐다면 서버 승인 전에 등록을 시도한 것이 원인일 수 있습니다. 수정된 버전은 `invite`를 별도로 지원하고 등록 실패 시에도 초대 링크와 오류 코드를 보여 줍니다.

| 새 오류 표시 | 의미와 확인 순서 |
|---|---|
| HTTP 401 | 인증 정보가 유효하지 않음. Bot 토큰인지, 재발급 전 값인지, 잘못 복사했는지 확인 |
| API 50001 / Missing Access | 대상 리소스 접근 불가. 대상 서버 초대·명령어 범위 승인, 서버 ID, 토큰과 앱 ID 조합 확인 |
| API 50013 / Missing Permissions | 필요한 권한 부족. 앱 설치·명령어 권한 확인. 무조건 관리자 권한을 줄 필요는 없음 |
| API 10002 | 알 수 없는 앱. Application ID 확인 |
| API 10004 | 알 수 없는 서버. 서버 ID 확인 |
| API 50035 | 요청 형식 오류. 명령어 정의 코드도 확인해야 함 |
| HTTP 429 | 요청 제한. 잠시 후 재시도 |
| HTTP 5xx | Discord 서버 오류. 잠시 후 재시도 |
| ENOTFOUND·ETIMEDOUT 등 | DNS·인터넷·프록시·시간 초과 등 연결 문제 |

여러 원인이 같은 코드로 나타날 수 있으므로 코드는 진단의 출발점입니다. 오류 코드와 안내 문장은 공유해도 되지만 토큰·`.env` 전문은 공유하지 마세요.

공식 자료: [앱 생성·설치](https://github.com/discord/discord-api-docs/blob/main/developers/quick-start/getting-started.mdx), [서버 명령어 승인](https://docs.discord.com/developers/docs/interactions/slash-commands), [오류 코드](https://docs.discord.com/developers/topics/opcodes-and-status-codes).
