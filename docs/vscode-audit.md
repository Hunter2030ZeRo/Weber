# VS Code 초기 소스 조사

조사일: 2026-09-09. 실행 검증이 아닌 시작 경로의 제한적인 정적 조사다.

- VS Code 기준 커밋: `97be5ba242f0d03048aacb01f11bea8e3a2c264a`
- 해당 소스의 [.npmrc](https://github.com/microsoft/vscode/blob/97be5ba242f0d03048aacb01f11bea8e3a2c264a/.npmrc)는 Electron 헤더 대상 버전을 `42.10.0`으로 지정한다.
- 이 버전은 VS Code 조사 기준이다. Weber의 기존 Electron 참조 서브모듈 버전과
  일치함을 뜻하지 않으며, 실제 포크 기준을 정할 때 두 버전을 명시적으로 맞춰야 한다.

## 직접 확인한 의존성

| 소스 | 확인한 기능 | Weber의 현재 차단 요인 |
| --- | --- | --- |
| [preload.ts](https://github.com/microsoft/vscode/blob/97be5ba242f0d03048aacb01f11bea8e3a2c264a/src/vs/base/parts/sandbox/electron-browser/preload.ts) | require('electron'), ipcRenderer의 invoke/send/on/once/removeListener, contextBridge.exposeInMainWorld | 모듈 해석, 격리된 preload, 양방향 IPC 미구현 |
| 같은 preload | webFrame.setZoomLevel, webUtils.getPathForFile | 배율과 운영체제 파일 객체 연결 미구현 |
| 같은 preload | 수신 이벤트의 ports를 window.postMessage로 전달 | JSON 전용 IPC로 메시지 포트를 전송할 수 없음 |
| [windowImpl.ts](https://github.com/microsoft/vscode/blob/97be5ba242f0d03048aacb01f11bea8e3a2c264a/src/vs/platform/windows/electron-main/windowImpl.ts) | BrowserWindow 생성, preload 지정, 화면 정보, 창 이벤트와 작업 화면 URL 구성 | 다중 창·화면 API·preload·탐색 호환성 부족 |
| [windows.ts](https://github.com/microsoft/vscode/blob/97be5ba242f0d03048aacb01f11bea8e3a2c264a/src/vs/platform/windows/electron-main/windows.ts) | 기본 창의 sandbox: true | 현재 호스트는 운영체제 샌드박스 미구현 |

## 설계에 적용할 결정

1. window.weber.invoke를 VS Code 코드 전체에 대입하는 방식으로 이식하지 않는다.
   기존 preload와 IPC 계약을 지원해야 한다.
2. JSON 전송은 현재 프로토타입의 제약이다. 호환 프로토콜에는 다중 인자와 구조화 복제,
   메시지 포트의 소유권 이전·종료·발신자 검증 설계가 필요하다.
3. contextBridge는 함수 이름을 추가하는 것으로 완료되지 않는다. 별도 실행 환경과
   경계 간 값/함수 전달을 먼저 구현한다. OS 샌드박스는 별도 필수 과제다.
4. 창별 에이전트 접근은 이 권한 경계 위의 선택 기능으로 추가한다. 일반 페이지나
   다른 창이 에이전트 연결을 통해 권한을 얻지 못해야 한다.

이 조사만으로 VS Code 전체 의존성을 파악했다고 주장하지 않는다. 확장 호스트,
터미널, 사용자 지정 프로토콜, 저장소, 네이티브 모듈, 웹뷰, 접근성과 웹 표준을
추가 조사하고, 실제 실행 경로에서 사용하는 API 목록 및 이식 패치를 검증해야 한다.
