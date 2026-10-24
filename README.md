# 🧊 3D Mod Viewer for Migoto Studio (mod-viewer-for-migoto-studio)

[Migoto Studio](https://github.com/DPN-dpn)를 위한 독립 3D 모드 뷰어 및 실시간 토글 인스펙터 플러그인입니다.  
에디터에서 열려 있는 3DMigoto 및 XXMI 기반 게임(원신, 젠레스 존 제로, 붕괴: 스타레일 등) 모드 폴더의 3D 메쉬와 DDS/이미지 텍스처를 Three.js 뷰포트로 즉시 시각화하고 실시간으로 토글 및 텍스처를 제어할 수 있습니다.

---

## ✨ 주요 기능 (Key Features)

- **⚡ 순수 JS/Three.js 기반 고속 3D 렌더링**:
  - 번들러나 빌드 과정 없이 Migoto Studio 플랫폼에서 즉시 로드되어 실행됩니다.
  - 3DMigoto/XXMI의 `.buf`(Position, Texcoord) 바이너리와 `.ib`(Index Buffer, DXGI_FORMAT_R32/R16)를 실시간 해석하여 Three.js 버퍼 지오메트리로 렌더링합니다.
- **🎨 DDS 및 텍스처 실시간 디코딩**:
  - DX10/BC1(DXT1), BC3(DXT5), BC7 등 다양한 DDS 텍스처 및 PNG/JPG 이미지를 WebGL 텍스처로 파싱하여 메쉬에 입힙니다.
- **🧩 코어 텍스처 슬롯 매칭 엔진 연동**:
  - Migoto Studio 코어의 모델/텍스처 슬롯 매칭 엔진(`context.slots`)과 상호작용하여, 부위별로 지정된 텍스처(`Diffuse`, `NormalMap` 등)를 자동 반영합니다.
  - 슬롯 매칭 패널에서 부위나 텍스처를 변경하면 뷰어에 실시간으로 자동 동기화됩니다.
- **🔄 파츠별 텍스처 실시간 교체 드롭다운**:
  - 뷰어 우측 파츠 목록에서 각 파츠마다 텍스처 드롭다운을 제공하여, 잘못 매칭되었거나 다른 텍스처를 테스트하고 싶을 때 즉석에서 자유롭게 교체할 수 있습니다.
- **🕹️ 인터랙티브 토글 컨트롤 ($dress, $shoe 등)**:
  - INI에 정의된 토글 변수와 상태 리스트를 자동 파싱하여 버튼/슬라이더 GUI를 생성합니다.
  - 토글 조작 시 실시간 조건식(`evaluateCondition`)을 통해 메쉬 서브파츠의 가시성을 즉각 켜고 끕니다.
- **📐 직관적인 모델 기준축(Orientation) 설정**:
  - 게임마다 다른 모델 축을 손쉽게 맞출 수 있도록 **기본 형식(+Y 위, -Z 앞)**과 **젠레스 존 제로(ZZZ) 형식(-Z 위, -Y 앞)** 원클릭 프리셋 버튼 및 커스텀 축 선택을 제공합니다.
- **🗔 독립 서브 윈도우 & PiP(별도 OS 창) 완벽 지원**:
  - 메인 에디터 내부의 플로팅 창(`openSubWindow`)뿐만 아니라, PiP 버튼(`⧉`) 클릭 시 완전히 독립된 데스크톱 OS 윈도우(`WebviewWindow`)로 분리되어 듀얼 모니터에서 넓게 작업할 수 있습니다.
  - 메인 창과 별도 창 간의 3D 데이터 캐시 및 조작 상태(축, 토글 변수, 카메라 시점)가 실시간으로 양방향 동기화됩니다.
- **🧹 Zero-Leakage 메모리 및 생명주기 관리**:
  - 모드 폴더가 닫히거나 에디터 작업 영역이 초기화될 때(`onDidClearMemory`), Three.js 씬 안의 모든 지오메트리, 재질, 텍스처 및 내부 캐시 메모리를 즉시 해제합니다.
  - 에디터에서 INI 파일을 수정하고 저장(`Ctrl+S`)하면 3D 뷰어에 변경 사항이 자동으로 리로드됩니다.

---

## 📥 설치 방법 (Installation)

### 방법 1. 플러그인 폴더에 직접 복사
1. 이 저장소를 `.zip`으로 다운로드합니다.
2. Migoto Studio 설치 폴더의 `plugins/` 디렉터리에 압축을 풀고, 폴더명을 `mod-3d-viewer`로 지정합니다:
   ```
   migoto-studio/
   └── plugins/
       └── mod-3d-viewer/
           ├── plugin.json
           ├── index.js
           ├── subwindow.js
           ├── style.css
           ├── core/
           ├── ui/
           └── libs/
   ```

### 방법 2. Git Clone
```bash
cd /path/to/migoto-studio/plugins
git clone https://github.com/DPN-dpn/mod-viewer-for-migoto-studio.git mod-3d-viewer
```

---

## 🚀 사용 방법 (Usage)

1. Migoto Studio 에디터 파일 탐색기에서 작업할 3D 모드 폴더를 엽니다.
2. 상단 메인 메뉴바에서 **[플러그인] ➔ [3D 모드 뷰어 열기]** 를 클릭하거나 단축키 **`Ctrl+Shift+V`** 를 누릅니다.
3. 뷰어가 실행되면 자동으로 3D 메쉬와 텍스처가 로드되며, 우측 패널에서 토글 변수 조작 및 파츠별 텍스처 변경을 수행할 수 있습니다.

---

## 📁 프로젝트 구조 (Project Structure)

```
mod-viewer-for-migoto-studio/
├── plugin.json          # Migoto Studio 플러그인 매니페스트
├── index.js             # 플러그인 엔트리포인트 (activate/deactivate 및 전역 생명주기 연동)
├── subwindow.js         # 서브 윈도우 및 데스크톱 독립 OS 창(PiP) 생명주기 오케스트레이터
├── style.css            # 3D 뷰어 및 UI 컴포넌트 전용 스타일시트
├── core/
│   ├── buffer_loader.js # .buf (Position, Texcoord) 및 .ib (인덱스) 바이너리 파서
│   ├── dds_decoder.js   # BC1, BC3, BC7 등 DDS 텍스처 및 이미지 디코더
│   ├── ini_parser.js    # 3DMigoto/XXMI INI 파일 파서 (토글 변수, ib 구문 기반 파츠 추출)
│   ├── mod_loader.js    # 모드 디렉터리 스캔, 코어 슬롯 연동 및 메모리 캐시 파이프라인
│   ├── scanner.js       # 작업 영역 파일 및 디렉터리 고속 탐색
│   ├── state.js         # 조작 상태(축, 카메라, 텍스처, 변수) 영구 보존 및 동기화
│   └── viewer3d.js      # Three.js 씬, 조명, 오빗 컨트롤, 파츠별 텍스처 매핑 렌더러
├── ui/
│   ├── app_layout.js    # 3D 뷰어 메인 레이아웃 및 워크스페이스 이벤트 오케스트레이터
│   ├── ini_dropdown.js  # 좌측 상단 멀티 INI 선택 드롭다운 팝오버
│   ├── toggle_panel.js  # 우측 토글 변수 컨트롤 및 파츠 목록/텍스처 드롭다운 패널
│   └── toolbar.js       # 상단 툴바 (축 선택, 기본/ZZZ 프리셋, 와이어프레임 등)
└── libs/
    ├── three.module.js  # Three.js 코어 모듈
    └── OrbitControls.js # 3D 카메라 오빗 컨트롤 모듈
```

---

## 📜 라이선스 (License)

MIT License.
