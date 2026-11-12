# Linux 자동 배포

현재 파일은 연결 준비가 된 템플릿입니다. GitHub 저장소·SSH 대상 정보가 아직 연결되지 않았으며 실제 서버 배포는 수행하지 않았습니다.

## 구조

`main` 푸시 → GitHub Actions에서 Node 24 테스트 → SSH 소스 전송 → Linux에서 Docker 빌드 → 실행 중 SQLite 백업 → 컨테이너 교체 → Discord 연결 상태 확인 → Discord 명령어 자동 등록.

현재 JavaScript 프로젝트에는 별도 컴파일이 필요 없습니다. Docker 이미지 생성이 빌드 단계입니다. 서버에서 빌드하므로 서버 CPU 아키텍처에 맞는 이미지가 만들어집니다. PR은 테스트만 수행합니다. main 브랜치에서 수동 실행도 가능합니다. 저장소에는 **maple-discord-bot 폴더의 내용이 루트**에 있어야 합니다. 모노레포라면 작업 경로 수정이 필요합니다.

## 서버 최초 준비 (한 번)

전제: Bash, tar, util-linux의 flock, Docker Engine, `docker compose up --wait`를 지원하는 Compose v2. SSH 계정이 설치 경로를 쓰고 Docker를 실행할 수 있어야 합니다. Docker 실행 권한은 서버 관리자에 준하는 권한이므로 전용 계정을 사용하세요. 배포 중 외부 npm 및 Docker 이미지 다운로드가 가능합니다. 일반 GitHub 호스팅 러너에서 SSH 서버에 접속할 수 있어야 하며 사설망 서버는 별도 연결 방식이 필요합니다.

서버 설치 경로를 `/opt/maple-bot`으로 선택한 예시입니다. 실제 접속 계정과 경로에 맞춰 설정합니다.

```sh
# 서버에서 실행. deployuser는 실제 SSH 계정으로 교체
sudo mkdir -p /opt/maple-bot/shared/data /opt/maple-bot/releases /opt/maple-bot/incoming
sudo chown -R deployuser:deployuser /opt/maple-bot
# 컨테이너 node 사용자의 UID/GID
sudo chown 1000:1000 /opt/maple-bot/shared/data
sudo chmod 700 /opt/maple-bot/shared/data
```

서버의 `/opt/maple-bot/shared/.env`에 봇 토큰·앱 ID·서버 ID를 직접 저장하고 권한을 600으로 설정합니다. `.env` 예시는 프로젝트 루트의 `.env.example`을 참고하세요. DB 경로는 Compose가 `/app/data/bot.sqlite`로 고정합니다.

기존 DB를 옮긴다면 기존 봇을 먼저 종료하고 검증한 SQLite 백업을 `shared/data/bot.sqlite`로 복사한 뒤 파일 소유자를 1000:1000으로 설정하세요. Mac과 서버에서 같은 봇을 동시에 실행하지 마세요.

## GitHub 설정

Repository → Settings → Secrets and variables → Actions에서 다음 값을 설정합니다. 개인 키와 토큰은 채팅이나 Git에 올리지 않습니다.

| 종류 | 이름 | 값 |
|---|---|---|
| Secret | SSH_HOST | 서버 DNS 이름 또는 IPv4 주소 |
| Secret | SSH_USER | SSH 접속 계정 |
| Secret | SSH_PORT | SSH 포트, 생략 시 22 |
| Secret | SSH_PRIVATE_KEY | 전용 배포 키의 개인 키 전체. 대응 공개 키는 서버 authorized_keys에 등록 |
| Secret | SSH_KNOWN_HOSTS | 확인한 서버 호스트 키의 known_hosts 형식 |
| Variable | DEPLOY_PATH | 예: /opt/maple-bot (공백 없는 절대경로) |

호스트 키는 신뢰할 수 있는 서버 콘솔의 SSH 호스트 키 지문과 대조해 등록합니다. 비표준 포트는 known_hosts에 `[호스트]:포트` 형식이 필요합니다. 워크플로는 호스트 키 검증을 끄지 않습니다. 봇 토큰은 서버 .env에만 둡니다.

설정이 끝나면 main에 커밋·푸시하거나 Actions에서 수동 실행합니다. 자동 배포를 원하지 않는 개발 변경은 별도 브랜치에서 진행합니다. 이 워크플로는 저장소 루트가 봇 프로젝트라는 전제이며 아직 현재 작업 폴더에 Git 저장소를 생성하거나 원격을 연결하지 않았습니다.

## 운영과 복구

파일 배치:

```text
/opt/maple-bot/
  shared/.env              # 배포로 덮어쓰지 않음
  shared/data/bot.sqlite   # 배포로 덮어쓰지 않음
  shared/data/backups/     # 교체 전 SQLite 백업
  releases/<배포 ID>/      # 버전별 소스
  current -> releases/... # 마지막 정상 배포
  incoming/               # 전송된 소스 압축 파일
```

봇 연결 상태를 5초마다 파일에 기록하고 컨테이너가 이를 검사합니다. 단순 프로세스 실행만으로 성공 처리하지 않습니다. 120초 안에 새 컨테이너가 healthy가 되지 않으면 이전 버전으로 복귀를 시도하고 작업을 실패 처리합니다. 첫 배포 실패는 컨테이너를 종료합니다. 재시작 정책은 프로세스 종료에 적용되며, 실행 중 unhealthy만으로 Docker가 자동 재시작하지는 않습니다.

코드 롤백은 DB를 되감지 않습니다. 향후 비호환 DB 마이그레이션을 추가하면 별도 이관·복구 설계가 필요합니다. 배포 때 짧은 봇 중단이 발생합니다. 백업·릴리스·이미지는 자동 삭제하지 않으므로 디스크 사용량을 확인하고 보존 정책을 정해야 합니다. 같은 서버의 백업이므로 서버 디스크 손실 대비 원격 백업은 별도입니다.

```sh
cd /opt/maple-bot/current
export RELEASE_ID="$(basename "$(pwd -P)")"
docker compose -p maple-bot ps
docker compose -p maple-bot logs --tail=100 bot
```

첫 설치와 이후 모든 배포에서 봇 연결 상태 확인 후 Discord 명령어를 자동 등록합니다. 등록이 실패하면 배포를 실패 처리하고, 이전 버전이 있는 경우 해당 코드로 복구한 뒤 이전 명령어 정의도 다시 등록합니다. 복구 또는 재등록 실패는 Actions 로그에서 확인해야 합니다. 수동으로 명령어만 다시 등록하려면 다음을 실행하세요.

```sh
docker compose -p maple-bot exec -T bot node scripts/register.js
```

처음에는 앱을 Discord 서버에 초대해야 합니다. 로그에 출력되는 토큰 등 비밀값을 공유하지 마세요. 기존 스크립트는 오류의 코드만 출력하도록 설계되어 있습니다.

참고: [GitHub Actions 워크플로 설정](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [GitHub Secrets](https://docs.github.com/en/actions/concepts/security/secrets).
