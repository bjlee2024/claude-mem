# origin 기반 프로젝트 분류 설계

- 작성일: 2026-06-29
- 상태: 설계 승인 완료 (구현 plan 대기)

## 1. 배경 & 문제

프로젝트 이름은 현재 `src/utils/project-name.ts`의 `getProjectName(cwd)`가 결정한다.
이미 `git rev-parse --show-toplevel`로 git repo를 인식하지만, **repo root의 폴더명
(basename)**을 이름으로 쓴다. 그래서 같은 git repo라도 로컬 폴더 경로/이름이 다르면
다른 프로젝트로 갈린다:

- `~/Work/claude-mem` → `claude-mem`
- 같은 repo를 `~/temp/claude-mem-copy`로 clone → `claude-mem-copy` (다른 프로젝트)

폴더명에 묶여 있어 clone 위치에 의존하는 것이 근본 원인이다. 관리 복잡성을 줄이려면
clone 위치와 무관한 **repo 정체성(origin)** 기반으로 분류해야 한다.

## 2. 목표 / 비목표

### 목표
- git repo면 origin remote 기반 `owner/repo`로 분류(clone 위치/폴더명 무관).
- origin이 없는 git repo는 repo root 폴더명, git이 아니면 cwd 폴더명으로 fallback.
- git worktree는 같은 origin을 공유하므로 같은 `owner/repo`로 통합(현 `parent/worktree`
  composite 제거).
- 기존 폴더명 기반 프로젝트 데이터를 새 이름으로 마이그레이션(통합).

### 비목표 (YAGNI)
- 점진적 자동 rename. 마이그레이션은 명시적 일회성 CLI.
- gitlab subgroup 다단계 경로(`group/subgroup/repo`)의 완전 보존 — 마지막 2 segment만.
- origin 외 다중 remote 선택 — origin만 사용.

## 3. 결정 사항 (확정)
- 형식: `owner/repo` (예: `bjlee2024/claude-mem`).
- fallback: origin 없는 git repo → repo root basename; git 아님 → cwd basename.
- worktree → `owner/repo`로 통합.
- 마이그레이션 → repo별 일회성 CLI(Approach A).

## 4. 컴포넌트 설계

### 4.1 핵심 로직 (`src/utils/project-name.ts`)
```
getProjectName(cwd):
  if !cwd: return 'unknown-project'
  repoRoot = findGitRepoRoot(cwd)                 # 기존 함수 유지
  if repoRoot:
    origin = gitRemoteOriginUrl(repoRoot)         # 신규
    if origin:
      parsed = parseOwnerRepo(origin)             # 신규
      if parsed: return parsed
    return basename(repoRoot)                      # origin 없음/파싱 실패 → repo 폴더명
  return basename(cwd)                             # git 아님 → cwd 폴더명
```
- 기존 빈 cwd / 루트 디렉터리 / Windows 드라이브 fallback 처리는 유지.
- `getProjectContext`: `detectWorktree` 분기 제거 →
  `{ primary: getProjectName(cwd), parent: null, isWorktree: false, allProjects: [primary] }`.
  (`worktree.ts`/`detectWorktree`는 다른 사용처가 없으면 import만 제거; 파일 삭제는 별도.)

### 4.2 origin 조회 & 파싱 (신규 helper, 같은 파일)
- `gitRemoteOriginUrl(repoRoot): string | null`
  - `git -C <repoRoot> remote get-url origin` (execFileSync, stdio 무시·trim). 실패/빈값 → null.
- `parseOwnerRepo(url): string | null`
  - SSH `git@host:owner/repo.git`, HTTPS `https://host/owner/repo(.git)`, `ssh://...` 등 처리.
  - 절차: 끝의 `.git` 제거 → host 구분자(`:` 또는 첫 `/path`) 이후의 경로 추출 →
    `/`로 split, 빈 segment 제거 → 마지막 2개를 `owner/repo`로 결합.
  - segment가 1개뿐이거나 파싱 불가 → null(호출부에서 repo basename fallback).

### 4.3 server rename endpoint (`ServerV1PostgresRoutes`)
- `POST /v1/projects/rename` (writeAuth) — **server-beta가 실제 마운트하는
  `ServerV1PostgresRoutes`에 등록**(이전 `/v1/logs/ingest` 교훈: SQLite용 `ServerV1Routes`가
  아니라 Postgres 모듈에 추가). body `{ from: string, to: string }` (zod 검증).
- team scope는 인증 컨텍스트에서 획득. 결과 JSON: `{ id, name, merged: boolean }`.

### 4.4 repository rename/merge (`src/storage/postgres/projects.ts`)
- `PostgresProjectsRepository.renameOrMerge(teamId, from, to)`:
  - `from`/`to`를 `(team_id, name)`으로 조회.
  - `from` 없음 → no-op(이미 신 이름이거나 미존재) 반환.
  - `to` 없음 → `UPDATE projects SET name=to WHERE id=from.id`.
  - `to` 존재 → **병합**: `from`을 참조하는 `server_sessions`/`agent_events`/`observations`의
    `project_id`를 `to.id`로 UPDATE 후 `from` 프로젝트 행 DELETE.
  - 단일 트랜잭션으로 원자적 처리. (참조 테이블 목록은 구현 시 schema에서 확인해 누락 없이.)

### 4.5 client 전송 (`ServerBetaClient`)
- `renameProject(from, to): Promise<{ id: string; name: string; merged: boolean }>` —
  `POST /v1/projects/rename` (인증 helper 재사용).

### 4.6 마이그레이션 CLI (`claude-mem project migrate`)
- 신규 서브커맨드(현재 CLI에 `project` 없음). 각 repo 디렉터리에서 실행:
  - `oldName` = 폴더명 기반(현 로직 보존 함수 또는 basename 계산), `newName` = `getProjectName(cwd)`(신 로직).
  - `oldName === newName` → 변경 없음 안내 후 종료.
  - 다르면 `ServerBetaClient.renameProject(oldName, newName)` 호출.
  - 성공 시 `project-map.json`에서 `oldName` 키 제거하고 `newName`→id 갱신(`ProjectResolver`에
    rename helper 추가, 예: `applyRename(from, to, id)`가 cache 수정 + persist).
  - `--dry-run`: 계산된 old/new와 server 변경 예정만 출력, 호출 없음.
- 클라이언트 런타임 전제: `CLAUDE_MEM_SERVER_BETA_URL`/`API_KEY` 필요(미설정 시 명확한 에러).

## 5. 데이터 흐름
1. 평시: hook → `getProjectName(cwd)` → owner/repo → `ProjectResolver.resolve` → server UUID.
2. 마이그레이션: `project migrate`(repo 내) → old/new 계산 → `/v1/projects/rename` →
   Postgres rename 또는 merge → `project-map.json` 갱신.

## 6. 에러 처리
- git/origin 조회 실패는 조용히 fallback(basename) — 기존 패턴.
- `parseOwnerRepo` 실패 → repo basename.
- rename에서 `from` 미존재 → no-op(에러 아님). `to` 충돌 → 병합(에러 아님).
- CLI는 server 미설정/요청 실패 시 비제로 종료 + 메시지.

## 7. 테스트
- 단위(`tests/utils/project-name.test.ts` 확장):
  - `parseOwnerRepo`: SSH/HTTPS/ssh://, `.git` 유무, 1-segment 실패 fallback.
  - `getProjectName`: git+origin → owner/repo, git+no-origin → repo basename(temp git init),
    non-git → cwd basename. (git 호출은 임시 repo로 실제 실행하거나 helper 주입.)
  - `getProjectContext`: worktree여도 composite 없이 owner/repo.
- repository(Postgres 통합): rename(미충돌) 및 merge(충돌 시 참조 재할당 + from 삭제) 원자성.
- CLI: `--dry-run`이 server 호출 없이 old/new 출력.

## 8. 영향 파일(예상)
- `src/utils/project-name.ts` — 핵심 로직 + `gitRemoteOriginUrl`/`parseOwnerRepo`, worktree 분기 제거.
- `src/storage/postgres/projects.ts` — `renameOrMerge`.
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` — `POST /v1/projects/rename`.
- `src/services/hooks/server-beta-client.ts` — `renameProject`.
- `src/services/hooks/project-resolver.ts` — rename helper(cache/persist).
- 신규 CLI 핸들러 + `src/npx-cli/`의 서브커맨드 라우팅(`project migrate`).
- 테스트 파일들.

## 9. 위험 / 확인 항목 (구현 시)
- `getProjectContext` 소비자가 `parent`/`isWorktree`/`allProjects`에 의존하는 곳 확인(있으면
  안전한 기본값 유지).
- merge 대상 참조 테이블 전수 확인(schema 기준) — 누락 시 고아 레코드.
- rename 라우트는 반드시 `ServerV1PostgresRoutes`(server-beta 마운트 모듈)에 등록.
