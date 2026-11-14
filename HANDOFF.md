# 깡통 노선도 — 작업 인수인계 메모 (v1.0.4)

SillyTavern 확장. 캐릭터별 챗방/브랜치를 지하철 노선도처럼 정리한다.
새 대화에서 이 파일을 먼저 읽고 이어서 작업할 것.

## 작업 규칙

- 유저는 비개발자. 설명은 한국어로 짧고 친절하게.
- **모델에게 보내는 프롬프트는 영어**로 작성(요약 프롬프트 등).
- `manifest.json`의 `author`는 `"User"` 유지. 제작자 정보를 코드·README·커밋 어디에도 넣지 말 것(사이트 규칙).
- 🏁 종착 상태는 **항상 유저가 직접** 붙인다. 자동 분류로 종착을 붙이면 안 됨.
- 할당량 아끼기: 파일 전체를 다시 읽지 말고 grep으로 필요한 부분만 볼 것.
- 버전 올릴 때 `manifest.json`의 version과 `index.js` 첫 줄 주석을 같이 바꾼다.
- 배포: 저장소에 push → 유저가 ST에서 확장 업데이트(또는 PC 확장 폴더에 직접 복사).

## 파일 구조

| 파일 | 역할 |
|---|---|
| `index.js` | 팝업 셸, 탭(TABS), 설정 화면(`settingsHtml`/`settingsChange`), ☰ 메뉴 버튼, `/subway`·`/노선도` 슬래시 명령, 이벤트 연결. 클릭은 `ticketClick → twinsClick → hubClick → mapClick` 순서로 넘김 |
| `core.js` | 공유 `state`, `app`(render/refresh 훅), 설정 기본값, 챗 API 래퍼, 트리 빌드, 상태/노선, AI 요약(`callModel`, `summarizeChat`, `bulkSummarize`) |
| `map.js` | 🗺️ 노선도 탭: 트리/상태별/노선별 보기, 드래그, 역 상세, 엿보기, 선택 모드(일괄 태그·삭제·추천) |
| `extras.js` | 분기점 찾기, 브랜치 AI 비교, 정리 기준(`cleanCfg`, `recommendCandidates`), 포스터 PNG, 분기 이름 묻기·역 안내방송(`onChatChanged`) |
| `hub.js` | 🌐 최근 탑승(봇 카드, 고정, 휴면, ST 태그 필터, 정리 센터) + 📊 승차 기록(잔디, 월별, 무거운 역, 오늘의 추천 등). 집계는 localforage `kkangtong_subway_hub_v2`에 캐시 |
| `ticket.js` | 🎫 환승 승차권: 메시지 범위를 잘라 다른 챗/다른 봇/새 챗으로 옮김. Memoria·코끼리 기억 같이 넘기기 |
| `twins.js` | 🪞 닮은꼴 탭: 중복/리뉴얼 캐릭터 찾기, 기준 카드와 비교, 체크해서 삭제 |
| `style.css` | 전체 스타일. 모든 규칙은 `#kts-root` 아래. 모바일은 `@media (max-width: 760px)` |

## 데이터 저장

- `extensionSettings.kkangtong_subway` (settings.json): 설정 + `chats[avatar][fileId] = {title, summary, status, pinned, line, titleLocked, summarizedCount, transferFrom}`, 그리고 `lines`, `pinnedBots`.
- 챗 파일 자체는 건드리지 않고 제목/요약은 확장 설정에만 저장한다. 예외: 승차권으로 메시지를 옮기거나, 삭제할 때.
- Syncthing의 `.stignore`가 `extensions*`와 `settings.json`을 빼고 있어서 PC↔폰 간에 제목/요약이 동기화되지 않는다(알려진 한계).

## ST 내부에서 알아둘 것

- 챗 목록: `POST /api/characters/chats {avatar_url, metadata:true}` → `file_id, chat_items, last_mes, file_size, chat_metadata.main_chat`
- 챗 읽기/저장/삭제: `/api/chats/get`(→ `[header, ...messages]`), `/api/chats/save {ch_name, file_name, chat, avatar_url}`, `/api/chats/delete {chatfile, avatar_url}`
- 전체 최근 챗: `/api/chats/recent {max, metadata:true}`
- 브랜치: 파일 이름이 `"X - Branch #N"`이고 `chat_metadata.main_chat`이 부모를 가리킨다.
- 캐릭터 전체 데이터: `/api/characters/get {avatar_url}`. 유저 PC는 `lazyLoadCharacters: false`라 `ctx().characters`에 이미 다 들어 있음.
- 캐릭터 삭제: `import('/script.js')`의 `deleteCharacter(avatars[], {deleteChats})` 사용(태그·UI 정리까지 됨). 실패하면 `/api/characters/delete`로 대체.
- 다른 봇 챗 열기(`openChatOf`): `selectCharacterById`는 화면만 바꾼다. 새로고침 후 복원되는 "마지막 봇"(`settings.active_character`)과 "그 봇의 마지막 챗"(카드의 `chat` 필드)은 ST 클릭 핸들러가 따로 저장하므로, 우리가 직접 `setActiveCharacter`(import '/script.js') + `saveSettingsDebounced`, `/api/characters/merge-attributes {avatar, chat}`로 저장한다(v1.0.3에서 고친 버그). `openCharacterChat`은 카드를 스스로 저장한다.
- 챗 파일 이름 바꾸기(v1.0.4, `renameChatFile`): 설정 `renameFile`(기본 꺼짐)이 ✏️ 고치기 화면 체크박스의 기본값. 열린 챗이면 `ctx().renameChat`(ST 방식), 아니면 `/api/chats/rename` + 카드 `chat` 필드 merge-attributes + `CHAT_RENAMED` 직접 emit. 그 챗에서 갈라진 지선의 `chat_metadata.main_chat`도 새 이름으로 고친다(열린 지선이면 `chatMetadata`+`saveMetadata`). 파일명 금지문자는 `fileSafeName`으로 제거, 같은 이름(대소문자 무시)이 있으면 거부.
  - 일괄: `bulkSummarize({all, ids})` 확인창에 「역 이름으로 실제 챗 파일 이름도 바꾸기」 체크(기본값 = `renameFile`). 선택 모드 하단 「🤖 N개 요약」도 같은 흐름. 요약이 다 끝난 뒤 성공한 것만 하나씩 `renameFilesToTitles`로 바꾸며, **ST 기본 이름(`isDefaultChatName`: 날짜@시분초[ms][ - Branch #N])인 파일만** 바꾼다. 유저가 직접 바꾼 파일 이름은 절대 건드리지 않음(유저가 중요하게 요청). 이름이 겹치면 `제목 (2)`…`(5)`.
  - ✏️ 고치기: 이번 편집에서 역 이름을 실제로 고쳤을 때만 파일 이름을 바꾼다(요약만 고치면 안 건드림).
- 이력: "편의성 모음" 대응 안전망(CHAT_CHANGED마다 active_character 저장)과 싱크띵 대응(기기별 마지막 챗 기록)은 만들었다가 배포하지 않고 뺐음. 유저 쪽 새로고침 문제는 폰 실리 환경 문제로 해결됨.
- 확인 팝업 체크박스: `new ctx().Popup(html, POPUP_TYPE.CONFIRM, '', {customInputs:[{id,label,defaultState}]})` → `popup.inputResults.get(id)`
- 요약 호출: `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {includePreset:false}, override)`
  - override에 `vertexai_auth_mode, vertexai_region, vertexai_express_project_id`(chatCompletionSettings에서 복사), `reasoning_effort:'low'`, `include_reasoning:false`를 넣어야 함.
  - Gemini 3 계열은 기본 thinking이 높아서 느림. 'min'은 3.8 flash에서 미지원.
  - JSON이 잘려서 오는 경우가 있어 파서를 관대하게 만들고 `repairBrokenEntries`로 복구함. maxTokens 1500.
- 번역 확장은 번역문을 `extra.display_text`에 저장 → `shownText()`로 표시.
- Memoria: `chat_metadata.memoria`. 넘길 때는 `{type:'memoria-export', store}` 파일을 `#memoria_carry_input`에 넣는다.
- 코끼리를 생각하지마: `chat_metadata.long_memory`. 넘길 때 커서를 -1로 맞추는 등 carryOver 방식을 따른다.
- ST 모바일은 z-index를 29999까지 씀 → 우리 팝업은 30500. ST 팝업(dialog)은 top-layer라 그 위에 뜬다.
- ST 테마가 `small`/`b`/`code` 색을 바꿔서 글씨가 안 보이는 일이 있었음 → `color: inherit` 또는 직접 색을 지정.

## 닮은꼴(twins.js) 동작

- 묶는 기준(union-find): 정규화한 이름(`normName`: 괄호, `_v2`, 복사본/테스트, 끝 숫자 제거) / 첫 메시지 앞 400자 해시(20자 이상일 때) / 설명 앞 300자 해시(30자 이상일 때).
- 카드마다 🔗 이유는 **기준 카드와 1:1로** 다시 계산한다(`matchReasons`). 예전엔 묶음 전체의 이유를 합쳐서 보여주다가 오표시 버그가 있었음.
- 비교 항목
  - 텍스트 필드: 앞뒤 공통 부분을 잘라낸 뒤 글자 단위 LCS로 `+추가 −삭제` 계산. 너무 크면 문장 단위 LCS.
  - 목록형: 월드인포(파일이 다를 때만 열어봄), 내장 로어북, 정규식, TH 스크립트(폴더 평탄화), 추가 인사말 → `diffItems`.
  - 같은지/다른지만: 이미지(썸네일 해시), 태그, TH 변수, 기타 extensions 키.
- 삭제: ☐ 체크 → 하단 바 → 확인창("챗 파일도 같이 지우기"는 기본 꺼짐).

## 테스트

클라우드 쪽 하네스(`index.html`에 ST 목업, `mob.html`)를 playwright로 돌렸었다. 새 환경엔 없으니 필요하면 간단한 목업을 새로 만들 것. 실제 ST 동작(삭제, 요약 API)은 유저가 직접 확인해야 한다.

## 열려 있는 아이디어 (유저 답 아직 없음)

- 캐릭터를 안 열고 노선도를 열면 자동으로 🌐 최근 탑승 탭 보여주기 (v1.0.3: 설정 `startRecent`로 실리 켤 때 🌐 최근 탑승 띄우기는 추가됨, 기본 꺼짐)
- 모바일 승차권에서 "↕ 범위" 탭으로 범위 고르기 버튼
- ChatLobby에만 있는 기능 가져오기: 목록에서 바로 새 챗, 챗 즐겨찾기 목록
- (별도 확장) 퀵 페르소나 발전시키기. 노선도에는 넣지 않을 예정
