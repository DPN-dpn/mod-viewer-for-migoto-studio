/**
 * ui/toggle_panel.js
 * INI 파일에서 분석된 토글 변수들($dress, $shoe, $neck, $cum 등)의
 * 인터랙티브 컨트롤 UI와 현재 활성화된 파츠 목록 인스펙터를 렌더링합니다.
 */

export class TogglePanel {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {Record<string, number>} options.constants - 기본 변수값
   * @param {Record<string, number[]>} options.keyBindings - 변수별 가능한 상태값 리스트
   * @param {Record<string, string>} [options.varSourceIni] - 변수별 소속 INI 파일명 매핑
   * @param {Array<{ name: string, condition: string, count: number, id?: string, textureFile?: string, slot?: any }>} options.parts - 파츠 목록
   * @param {(variables: Record<string, number>) => void} options.onChange - 값 변경 콜백
   * @param {(part: any, textureFile: string) => void} [options.onTextureChange] - 파츠별 텍스처 변경 콜백
   * @param {string[]} [options.detectedTextures] - INI/모드 폴더에서 감지된 텍스처 파일 목록
   * @param {Record<string, string>} [options.partTextures] - 파츠별 현재 선택된 텍스처 매핑
   * @param {object} [options.context] - PluginContext 객체
   */
  constructor(container, { constants, keyBindings, parts, onChange, onTextureChange, detectedTextures, partTextures, context, varSourceIni }) {
    this.container = container;
    this.constants = { ...constants };
    this.keyBindings = keyBindings || {};
    this.parts = parts || [];
    this.onChange = onChange;
    this.onTextureChange = onTextureChange;
    this.detectedTextures = detectedTextures || [];
    this.partTextures = { ...(partTextures || {}) };
    this.context = context;
    this.varSourceIni = varSourceIni || {};
    this.currentValues = { ...this.constants };

    this.render();
  }

  render() {
    this.container.innerHTML = '';
    this.container.className = 'toggle-panel-root';

    // 1. 토글 컨트롤 상단 영역 구성
    const header = document.createElement('div');
    header.className = 'panel-section-title';
    header.innerHTML = `
      <span class="icon">🕹️</span>
      <span>모드 토글 컨트롤</span>
    `;

    const varListContainer = document.createElement('div');
    varListContainer.className = 'var-list-container';

    // 현재 활성화된 INI에 속하며 사용자가 조작 가능한 토글 변수만 선별 (내부 드로우 플래그 및 임시 백슬래시 변수 제외)
    const varNames = Object.keys(this.currentValues).filter((v) => {
      if (/^\$active\d*$/i.test(v)) return false;
      if (v.includes('\\')) return false;
      return true;
    });

    if (varNames.length === 0) {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'empty-note';
      emptyNote.textContent = '현재 활성화된 INI에 정의된 조작 가능한 토글 변수가 없습니다.';
      varListContainer.appendChild(emptyNote);
    } else {
      for (const varName of varNames) {
        const item = this.createVarControl(varName);
        varListContainer.appendChild(item);
      }
    }

    // 2. 메쉬 파츠 목록 하단 영역 구성
    const partsHeader = document.createElement('div');
    partsHeader.className = 'panel-section-title';
    partsHeader.innerHTML = `
      <span class="icon">🧩</span>
      <span>메쉬 파츠 목록 (${this.parts.length}개)</span>
    `;

    this.partsListContainer = document.createElement('div');
    this.partsListContainer.className = 'parts-list-container';

    // 3. context.ui.createSplitView를 통한 상하 스플릿 분할
    if (this.context?.ui?.createSplitView) {
      const panelSplit = this.context.ui.createSplitView({
        direction: 'vertical',
        initialSize: '50%',
        minFirstSize: 100,
        minSecondSize: 100,
        storageKey: 'mod_viewer_panel_split',
      });

      const topSection = document.createElement('div');
      topSection.className = 'panel-split-section';
      topSection.append(header, varListContainer);

      const bottomSection = document.createElement('div');
      bottomSection.className = 'panel-split-section';
      bottomSection.append(partsHeader, this.partsListContainer);

      panelSplit.firstPane.append(topSection);
      panelSplit.secondPane.append(bottomSection);

      this.container.appendChild(panelSplit.element || panelSplit.container);
    } else {
      // 스플릿 미지원 시 일반 스택 폴백
      this.container.appendChild(header);
      this.container.appendChild(varListContainer);
      partsHeader.classList.add('mt-4');
      this.container.appendChild(partsHeader);
      this.container.appendChild(this.partsListContainer);
    }

    this.updatePartsStatus();
  }

  createVarControl(varName) {
    const row = document.createElement('div');
    row.className = 'var-control-card';

    const header = document.createElement('div');
    header.className = 'var-header';

    const label = document.createElement('span');
    label.className = 'var-label';
    label.textContent = varName;
    header.appendChild(label);

    const sourceIni = this.varSourceIni?.[varName];
    if (sourceIni) {
      const iniBadge = document.createElement('span');
      iniBadge.className = 'var-ini-badge';
      iniBadge.textContent = sourceIni;
      iniBadge.title = `출처 INI: ${sourceIni}.ini`;
      header.appendChild(iniBadge);
    }

    const valueBadge = document.createElement('span');
    valueBadge.className = 'var-badge';
    valueBadge.textContent = `값: ${this.currentValues[varName]}`;
    header.appendChild(valueBadge);
    row.appendChild(header);

    const states = this.keyBindings[varName] || [0, 1];

    if (states.length <= 6) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'state-btn-group';

      for (const val of states) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `state-btn ${this.currentValues[varName] === val ? 'active' : ''}`;
        btn.textContent = String(val);
        btn.addEventListener('click', () => {
          this.setValue(varName, val, valueBadge, btnGroup);
        });
        btnGroup.appendChild(btn);
      }
      row.appendChild(btnGroup);
    } else {
      const sliderRow = document.createElement('div');
      sliderRow.className = 'slider-row';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(Math.min(...states));
      slider.max = String(Math.max(...states));
      slider.step = '1';
      slider.value = String(this.currentValues[varName]);
      slider.className = 'var-slider';

      slider.addEventListener('input', (e) => {
        const num = parseFloat(e.target.value);
        this.setValue(varName, num, valueBadge);
      });

      sliderRow.appendChild(slider);
      row.appendChild(sliderRow);
    }

    return row;
  }

  setValue(varName, val, badgeElement, btnGroupElement) {
    this.currentValues[varName] = val;
    if (badgeElement) {
      badgeElement.textContent = `값: ${val}`;
    }

    if (btnGroupElement) {
      const btns = btnGroupElement.querySelectorAll('.state-btn');
      btns.forEach((b) => {
        if (parseFloat(b.textContent) === val) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });
    }

    this.updatePartsStatus();

    if (this.onChange) {
      this.onChange(this.currentValues);
    }
  }

  updatePartsStatus() {
    if (!this.partsListContainer) return;
    this.partsListContainer.innerHTML = '';

    for (const part of this.parts) {
      const isVisible = this.checkCondition(part.condition);
      const partKey = part.id || part.name;

      const item = document.createElement('div');
      item.className = `part-item ${isVisible ? 'visible' : 'hidden'}`;

      const rowMain = document.createElement('div');
      rowMain.className = 'part-row-main';

      const statusDot = document.createElement('span');
      statusDot.className = `status-dot ${isVisible ? 'on' : 'off'}`;
      statusDot.title = isVisible ? '렌더링 활성' : '숨김 상태';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'part-name';
      nameSpan.textContent = part.name;

      const trisSpan = document.createElement('span');
      trisSpan.className = 'part-tris';
      trisSpan.textContent = `${Math.floor(part.count / 3).toLocaleString()} tris`;

      rowMain.appendChild(statusDot);
      if (part.slot?.partName) {
        const slotBadge = document.createElement('span');
        slotBadge.className = 'part-slot-badge';
        slotBadge.textContent = part.slot.partName;
        rowMain.appendChild(slotBadge);
      }
      rowMain.appendChild(nameSpan);
      rowMain.appendChild(trisSpan);
      item.appendChild(rowMain);

      // 텍스처 선택 드롭다운 영역
      const texRow = document.createElement('div');
      texRow.className = 'part-tex-row';

      const texLabel = document.createElement('span');
      texLabel.className = 'part-tex-label';
      texLabel.textContent = '텍스처:';
      texRow.appendChild(texLabel);

      const texSelect = document.createElement('select');
      texSelect.className = 'part-tex-select';
      texSelect.title = `${part.name}의 텍스처를 변경합니다`;

      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '(기본 / 텍스처 없음)';
      texSelect.appendChild(defOpt);

      const currentTex = this.partTextures[partKey] || part.textureFile || '';

      if (this.detectedTextures && this.detectedTextures.length > 0) {
        for (const tf of this.detectedTextures) {
          const opt = document.createElement('option');
          opt.value = tf;
          opt.textContent = tf;
          if (currentTex && (tf.toLowerCase() === currentTex.toLowerCase() || tf.toLowerCase().endsWith(currentTex.toLowerCase()))) {
            opt.selected = true;
          }
          texSelect.appendChild(opt);
        }
      }

      // 현재 연결된 텍스처가 감지 목록에 없으면 표시용 옵션 추가
      if (currentTex && !this.detectedTextures.some((t) => t.toLowerCase() === currentTex.toLowerCase())) {
        const customOpt = document.createElement('option');
        customOpt.value = currentTex;
        customOpt.textContent = `${currentTex} (지정됨)`;
        customOpt.selected = true;
        texSelect.appendChild(customOpt);
      }

      texSelect.addEventListener('change', (e) => {
        const chosen = e.target.value;
        this.partTextures[partKey] = chosen;
        this.onTextureChange?.(part, chosen);
      });

      texRow.appendChild(texSelect);
      item.appendChild(texRow);

      if (part.condition) {
        const condTooltip = document.createElement('div');
        condTooltip.className = 'part-condition-hint';
        condTooltip.textContent = `조건: ${part.condition}`;
        item.appendChild(condTooltip);
      }

      this.partsListContainer.appendChild(item);
    }
  }

  checkCondition(condition) {
    if (!condition) return true;
    try {
      let expr = condition.replace(/\$([a-zA-Z0-9_]+)/g, (match, v) => {
        const lower = ('$' + v).toLowerCase();
        const val = this.currentValues[lower];
        return val !== undefined ? String(val) : '0';
      });
      const sanitized = expr.replace(/[^0-9=!><&|\(\)\s\.\-]/g, '');
      const fn = new Function(`return Boolean(${sanitized});`);
      return fn();
    } catch {
      return true;
    }
  }

  destroy() {
    this.onChange = null;
    this.onTextureChange = null;
    this.currentValues = {};
    this.parts = [];
    this.constants = {};
    this.keyBindings = {};
    this.detectedTextures = [];
    this.partTextures = {};
    if (this.partsListContainer) {
      this.partsListContainer.innerHTML = '';
      this.partsListContainer = null;
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
