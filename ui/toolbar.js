/**
 * ui/toolbar.js
 * 3D 뷰어 상단 툴바 UI 컴포넌트입니다.
 * INI 드롭다운, 모델 기준 축(Up/Forward) 설정 셀렉트, 기본/ZZZ 프리셋 버튼,
 * 와이어프레임, 그리드, 자동회전, 카메라 리셋, 모드 새로고침 버튼을 조립하고 제어합니다.
 */

export class ViewerToolbar {
  /**
   * @param {object} options
   * @param {object} options.context - PluginContext
   * @param {object} options.iniDropdown - IniDropdown 인스턴스
   * @param {object} options.viewState - 현재 뷰어 조작 상태
   * @param {(axes: { up: string, forward: string }) => void} options.onAxisChange - 축 변경 시 콜백
   * @param {(toggleKey: string, active: boolean) => void} options.onToggle - 토글 버튼 변경 시 콜백
   * @param {() => void} options.onResetCamera - 카메라 리셋 콜백
   * @param {() => void} options.onReload - 모드 캐시 초기화 및 새로고침 콜백
   */
  constructor({ context, iniDropdown, viewState, onAxisChange, onToggle, onResetCamera, onReload }) {
    this.context = context;
    this.iniDropdown = iniDropdown;
    this.onAxisChange = onAxisChange;
    this.onToggle = onToggle;
    this.onResetCamera = onResetCamera;
    this.onReload = onReload;

    // 현재 선택된 축 설정 내부 상태 보존
    this.currentUp = viewState.upAxis || '+Y (기본)';
    this.currentForward = viewState.forwardAxis || '-Z (기본)';

    // 1. 축 선택 컴팩트 셀렉트
    this.selUpAxis = context.ui.createSelect({
      variant: 'compact',
      prefix: '위',
      title: '모델의 위(Up) 축 설정',
      options: ['+Y (기본)', '-Y', '+Z (Z-Up)', '-Z', '+X', '-X'],
      value: this.currentUp,
      onChange: () => this.handleAxisChange(),
    });

    this.selForwardAxis = context.ui.createSelect({
      variant: 'compact',
      prefix: '앞',
      title: '모델의 앞(Forward) 축 설정',
      options: ['-Z (기본)', '+Z', '-Y', '+Y', '+X', '-X'],
      value: this.currentForward,
      onChange: () => this.handleAxisChange(),
    });

    // 2. 프리셋 버튼
    this.btnPresetDefault = context.ui.createButton({
      text: '기본',
      variant: 'small',
      title: '기본 형식 (+Y 위, -Z 앞)',
      onClick: () => {
        this.selUpAxis.setValue('+Y (기본)');
        this.selForwardAxis.setValue('-Z (기본)');
        this.handleAxisChange();
      },
    });

    this.btnPresetZZZ = context.ui.createButton({
      text: 'ZZZ',
      variant: 'small',
      title: '젠레스 존 제로(ZZZ) 형식 (-Z 위, -Y 앞)',
      onClick: () => {
        this.selUpAxis.setValue('-Z');
        this.selForwardAxis.setValue('-Y');
        this.handleAxisChange();
      },
    });

    // 3. 상태 토글 버튼
    this.btnWireframe = context.ui.createToggleButton({
      text: '와이어프레임',
      icon: '📐',
      active: Boolean(viewState.isWireframe),
      onChange: (isActive) => this.onToggle?.('isWireframe', isActive),
    });

    this.btnGrid = context.ui.createToggleButton({
      text: '그리드',
      icon: '▦',
      active: viewState.isGrid !== false,
      onChange: (isActive) => this.onToggle?.('isGrid', isActive),
    });

    this.btnAutoRotate = context.ui.createToggleButton({
      text: '회전',
      icon: '🔄',
      active: Boolean(viewState.isAutoRotate),
      onChange: (isActive) => this.onToggle?.('isAutoRotate', isActive),
    });

    // 4. 리셋 및 새로고침 버튼
    this.btnResetCam = context.ui.createButton({
      text: '리셋',
      icon: '↩',
      variant: 'secondary',
      title: '카메라 시점 초기화',
      onClick: () => this.onResetCamera?.(),
    });

    this.btnReload = context.ui.createButton({
      text: '↻',
      variant: 'secondary',
      title: '모드 파일 새로고침 (캐시 비우고 디스크에서 재로드)',
      onClick: () => this.onReload?.(),
    });

    // 5. Migoto Studio UI 빌더 Toolbar 생성
    this.toolbar = context.ui.createToolbar({
      left: [this.iniDropdown.element],
      center: [this.selUpAxis, this.selForwardAxis, this.btnPresetDefault, this.btnPresetZZZ],
      right: [this.btnWireframe, this.btnGrid, this.btnAutoRotate, this.btnResetCam, this.btnReload],
    });
  }

  get element() {
    return this.toolbar.element || this.toolbar.getElement();
  }

  handleAxisChange() {
    const upVal = (typeof this.selUpAxis?.getValue === 'function' ? this.selUpAxis.getValue() : null) || this.currentUp || '+Y (기본)';
    const fwdVal = (typeof this.selForwardAxis?.getValue === 'function' ? this.selForwardAxis.getValue() : null) || this.currentForward || '-Z (기본)';
    this.currentUp = upVal;
    this.currentForward = fwdVal;
    this.onAxisChange?.({
      up: upVal,
      forward: fwdVal,
      rawUp: String(upVal).split(' ')[0] || '+Y',
      rawForward: String(fwdVal).split(' ')[0] || '-Z',
    });
  }

  /**
   * 외부 상태(viewState)를 툴바 컨트롤에 반영
   * @param {object} viewState
   */
  applyViewState(viewState) {
    if (!viewState) return;
    if (viewState.upAxis) {
      this.currentUp = viewState.upAxis;
      if (this.selUpAxis?.setValue) {
        this.selUpAxis.setValue(viewState.upAxis);
      }
    }
    if (viewState.forwardAxis) {
      this.currentForward = viewState.forwardAxis;
      if (this.selForwardAxis?.setValue) {
        this.selForwardAxis.setValue(viewState.forwardAxis);
      }
    }
    if (typeof viewState.isWireframe === 'boolean' && this.btnWireframe?.setActive) {
      this.btnWireframe.setActive(viewState.isWireframe);
    }
    if (typeof viewState.isGrid === 'boolean' && this.btnGrid?.setActive) {
      this.btnGrid.setActive(viewState.isGrid);
    }
    if (typeof viewState.isAutoRotate === 'boolean' && this.btnAutoRotate?.setActive) {
      this.btnAutoRotate.setActive(viewState.isAutoRotate);
    }
  }

  getUpAxis() {
    return this.currentUp || this.selUpAxis?.getValue?.() || '+Y (기본)';
  }

  getForwardAxis() {
    return this.currentForward || this.selForwardAxis?.getValue?.() || '-Z (기본)';
  }

  isWireframeActive() {
    return Boolean(this.btnWireframe?.isActive?.());
  }

  isGridActive() {
    return Boolean(this.btnGrid?.isActive?.());
  }

  isAutoRotateActive() {
    return Boolean(this.btnAutoRotate?.isActive?.());
  }
}
