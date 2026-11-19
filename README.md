# 영상 타임라인 매니저 (Video Timeline Manager)

유튜브 영상별 타임라인 메모를 엑셀(`.xlsx`)로 정리해 두고, 브라우저에서 검색·열람·편집하는 로컬 도구입니다.
엑셀 파일 하나는 폴더처럼, 시트 하나는 영상 하나로 인식합니다.

저장소: https://github.com/ERIM-Hyun/Video-Timeline-Manager · 새 버전은 [Releases](https://github.com/ERIM-Hyun/Video-Timeline-Manager/releases)에서 받을 수 있습니다.

**📖 [사용법 (화면 이미지 포함)](docs/사용법.md)** · [변경 이력](CHANGELOG.md)

## 주요 기능
- 타임라인 막대(확대·축소·이동), 검색 결과 위치 표시, 구간 클릭 시 메모 표시
- 전체 폴더 검색 · 영상 내 검색 · 검색식(예: `(가 OR 나) & 다`, `'두 단어'`)
- 키워드 버튼, 키워드 색상, 키워드 추가/삭제, 키워드로 찾기(전체 키워드 목록)
- 타임스탬프별 참고자료(파일) 연결, 메모를 엑셀 셀에 바로 수정
- 즐겨찾기: 타임스탬프마다 ☆ 버튼, 폴더 계층으로 정리·이동·검색, 검색할 때 결과 위쪽에 별도 구역으로 표시
- 타임라인 추가: 화면에서 시간(또는 유튜브 타임스탬프 링크 붙여넣기)·내용·키워드를 입력하면 엑셀의 시간 순서에 맞는 위치에 새 행으로 끼워 넣음(수식·표 등이 있거나 시간순이 아닌 시트는 맨 아래에 추가하고 안내)
- 영상을 재생·정지한 뒤 추가하면 플레이어의 현재 위치가 시간 기본값으로 들어감
- 설정(⚙️): 라이트/다크 모드와 화면 색 톤(색상·선명도·배경 색조, 프리셋) 조절
- 막대·화살표로 항목을 고르면 목록이 가운데로 이동하며 강조 표시
- 새 엑셀 문서 만들기(폴더 `＋`), 영상(시트) 추가(문서 `＋`): 영상 주소를 붙여넣으면 제목·재생 시간을 자동으로 불러오고, 템플릿 시트를 복사해 시트를 만듦 (라이브러리 폴더에 `템플릿.xlsx`를 두면 새 문서의 기본 양식으로 사용)
- 즐겨찾기가 있는 구간은 타임라인 막대 위에 ★로 표시, 키워드 입력 시 이미 있는 키워드를 자동완성·추천(초성 검색 지원)
- 라이브러리 맨 위 폴더의 Template.xlsx는 새 문서용 양식(목록에서 제외), 이름이 '템플릿'/'Template'인 시트는 항상 제외
- 종료할 때 엑셀에 없는 항목의 흔적을 timeline-refs.json에서 정리(걷어낸 내용은 timeline-refs.removed.json에 보관)
- 📥 다른 엑셀 불러오기: 다른 사람이 만든 엑셀에서 같은 영상(주소 비교)의 타임라인을 골라 병합 — 타임라인 단위 체크, 시간·내용·키워드만 가져옴, 같은 시간 항목은 별도 행으로 추가, 병합 전 자동 백업
- 새 버전 알림(선택): `app.py`의 `UPDATE_REPO`에 GitHub 저장소를 적으면 새 릴리스가 있을 때 알려 줍니다(알림만, 파일 자동 교체 없음, 설정에서 끌 수 있음)
- 진단: 오류가 있으면 버튼이 빨갛게 강조되고 개수가 표시됩니다. 시트 인식 결과 · 점검(읽지 않는 파일과 이유 등) · 연결 복구(파일을 옮기거나 이름을 바꿨을 때 즐겨찾기·참고자료·아이콘을 새 위치로 옮김)
- 폴더/파일/영상 아이콘(이모지) 지정
- 유튜브 임베드 플레이어로 해당 시간부터 재생

## 실행 방법 (Windows)
1. Python 3.8 이상 설치 (추가 패키지 없음, 표준 라이브러리만 사용)
2. `run.bat` 더블클릭 → 브라우저가 열립니다 (`http://127.0.0.1:8765/`)
3. 화면의 **폴더 변경**에서 엑셀 파일이 있는 폴더를 지정하거나, 이 폴더의 `library/`에 엑셀을 넣습니다
4. 종료: 화면의 **[종료]** 버튼 (브라우저를 닫으면 약 3분 뒤 자동 종료)

macOS/Linux: `python3 app.py`

사용 방법은 [`docs/사용법.md`](docs/사용법.md), 코드 구조는 [`docs/코드_설명서.md`](docs/코드_설명서.md)를 참고하세요.

## 개인정보·보안
- 서버는 `127.0.0.1`(내 컴퓨터)에서만 열립니다. 엑셀·참고자료 내용은 외부로 보내지 않으며, 유튜브 재생(YouTube 서버)과 새 버전 알림 확인(GitHub, 켠 경우)에서만 인터넷에 접속합니다.
- 키워드 색상·아이콘·참고자료 연결은 엑셀 폴더 안의 `timeline-refs.json`에 저장됩니다.
- 엑셀을 수정할 때는 `.backup` 사본을 만듭니다. 그래도 중요한 파일은 따로 백업하세요.

## AI 사용 고지
이 프로젝트의 코드와 문서는 AI(Anthropic의 Claude)의 도움을 받아 작성되었습니다.
사람이 요구사항을 정하고 결과를 확인했지만, 오류가 있을 수 있으니 중요한 데이터는 백업 후 사용하세요.

## 라이선스 · 수정 및 재배포
[MIT License](LICENSE)입니다. 누구나 자유롭게 사용·수정·재배포할 수 있습니다(상업적 이용 포함).
수정본을 배포할 때는 `LICENSE`의 저작권 및 허가 문구를 유지해 주세요. 개선 사항은 이슈/풀 리퀘스트로 환영합니다.

## YouTube 관련 고지
이 도구는 YouTube 또는 Google과 관련 없는 비공식 개인 도구입니다. YouTube의 공식 임베드 플레이어만 사용하며,
영상·썸네일을 내려받거나 저장하지 않고 YouTube Data API도 사용하지 않습니다.
영상 재생 시 [YouTube 서비스 약관](https://www.youtube.com/t/terms)과
[Google 개인정보처리방침](https://policies.google.com/privacy)이 적용됩니다.

---

# Video Timeline Manager (English summary)

A local tool that keeps per-video timeline notes in Excel (one workbook = a folder, one sheet = one video) and lets you search,
browse and edit them in a browser, with an embedded YouTube player. Python 3.8+ standard library only. Run `run.bat` (Windows) or `python3 app.py`.

**AI disclosure:** code and docs were written with the help of AI (Anthropic's Claude), directed and reviewed by a human. **License:** MIT — free to use, modify and redistribute.
**Not affiliated with YouTube or Google.** Uses only the official embedded player; does not download or store videos or thumbnails.
