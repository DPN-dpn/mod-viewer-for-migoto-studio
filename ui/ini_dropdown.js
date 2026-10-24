/**
 * ui/ini_dropdown.js
 * 감지된 INI 파일 목록을 드롭다운 팝오버로 표시하고,
 * 각 INI 파일의 활성화/비활성화 체크박스를 제어하는 UI 컴포넌트입니다.
 */

export class IniDropdown {
  /**
   * @param {object} options
   * @param {(entries: any[]) => void} options.onSelectionChange - 체크박스 변경 시 호출되는 콜백
   */
  constructor({ onSelectionChange }) {
    this.onSelectionChange = onSelectionChange;
    this.entries = [];
    this.folderName = '열린 모드 없음';

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'ini-dropdown-wrapper';

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'ini-dropdown-trigger';
    this.btn.title = '클릭하여 감지된 INI 파일 목록 및 반영 여부 선택';
    this.btn.innerHTML = `
      <span class="ini-dropdown-label" id="ini-dropdown-title">열린 모드 없음</span>
      <span class="ini-dropdown-badge" id="ini-dropdown-badge" style="display:none;">0/0</span>
      <span class="ini-dropdown-arrow">▾</span>
    `;

    this.menu = document.createElement('div');
    this.menu.className = 'ini-dropdown-menu';
    this.menu.style.display = 'none';

    this.wrapper.appendChild(this.btn);
    this.wrapper.appendChild(this.menu);

    this.btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });

    this.onDocClick = (e) => {
      if (!this.wrapper.contains(e.target)) {
        this.toggle(false);
      }
    };
    document.addEventListener('pointerdown', this.onDocClick);
    document.addEventListener('click', this.onDocClick);
  }

  get element() {
    return this.wrapper;
  }

  toggle(forceState) {
    const isVisible = this.menu.style.display === 'flex';
    const nextState = typeof forceState === 'boolean' ? forceState : !isVisible;
    this.menu.style.display = nextState ? 'flex' : 'none';
    this.btn.classList.toggle('active', nextState);
  }

  setFolder(folderName) {
    this.folderName = folderName || '열린 모드 없음';
    const titleEl = this.btn.querySelector('#ini-dropdown-title');
    if (titleEl) titleEl.textContent = this.folderName;
  }

  showEmpty() {
    this.entries = [];
    this.setFolder('열린 모드 없음');
    const badgeEl = this.btn.querySelector('#ini-dropdown-badge');
    if (badgeEl) badgeEl.style.display = 'none';

    this.menu.innerHTML = `
      <div style="padding: 12px; font-size: 12px; color: #64748b; text-align: center;">
        감지된 INI 파일이 없습니다.
      </div>
    `;
  }

  setEntries(entries, folderName) {
    this.entries = entries || [];
    if (folderName) this.setFolder(folderName);
    this.renderMenu();
    this.updateBadge();
  }

  updateBadge() {
    const total = this.entries.length;
    const enabledCount = this.entries.filter((e) => e.enabled).length;
    const badgeEl = this.btn.querySelector('#ini-dropdown-badge');

    if (badgeEl) {
      if (total > 0) {
        badgeEl.style.display = 'inline-block';
        badgeEl.textContent = `${enabledCount}/${total}`;
        badgeEl.title = `감지된 ${total}개 INI 중 ${enabledCount}개 활성화됨`;
      } else {
        badgeEl.style.display = 'none';
      }
    }
  }

  renderMenu() {
    const total = this.entries.length;
    const enabledCount = this.entries.filter((e) => e.enabled).length;

    this.menu.innerHTML = `
      <div class="ini-dropdown-header">
        <span class="ini-dropdown-header-title">감지된 INI 파일 (${enabledCount}/${total})</span>
        <div class="ini-dropdown-actions">
          <button type="button" class="ini-action-btn select-all">전체</button>
          <button type="button" class="ini-action-btn deselect-all">해제</button>
        </div>
      </div>
      <div class="ini-dropdown-list"></div>
    `;

    const btnSelectAll = this.menu.querySelector('.select-all');
    const btnDeselectAll = this.menu.querySelector('.deselect-all');
    const listContainer = this.menu.querySelector('.ini-dropdown-list');

    btnSelectAll.onclick = (e) => {
      e.stopPropagation();
      this.entries.forEach((entry) => (entry.enabled = true));
      this.renderMenu();
      this.updateBadge();
      this.onSelectionChange?.(this.entries);
    };

    btnDeselectAll.onclick = (e) => {
      e.stopPropagation();
      this.entries.forEach((entry) => (entry.enabled = false));
      this.renderMenu();
      this.updateBadge();
      this.onSelectionChange?.(this.entries);
    };

    this.entries.forEach((entry) => {
      const item = document.createElement('label');
      item.className = 'ini-dropdown-item' + (!entry.enabled ? ' disabled' : '');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ini-checkbox';
      checkbox.checked = entry.enabled;
      checkbox.onchange = (e) => {
        e.stopPropagation();
        entry.enabled = checkbox.checked;
        item.classList.toggle('disabled', !entry.enabled);
        this.updateBadge();
        const headerTitle = this.menu.querySelector('.ini-dropdown-header-title');
        if (headerTitle) {
          const curr = this.entries.filter((e) => e.enabled).length;
          headerTitle.textContent = `감지된 INI 파일 (${curr}/${total})`;
        }
        this.onSelectionChange?.(this.entries);
      };

      const textWrap = document.createElement('div');
      textWrap.className = 'ini-item-text';

      const nameSpan = document.createElement('div');
      nameSpan.className = 'ini-item-name';
      nameSpan.textContent = entry.relativeName || entry.name;
      nameSpan.title = entry.path;

      const metaSpan = document.createElement('div');
      metaSpan.className = 'ini-item-meta';
      metaSpan.textContent = `${entry.components.length}개 메쉬 · ${entry.parts.length}개 파츠`;

      textWrap.append(nameSpan, metaSpan);
      item.append(checkbox, textWrap);
      listContainer.appendChild(item);
    });
  }

  destroy() {
    document.removeEventListener('pointerdown', this.onDocClick);
    document.removeEventListener('click', this.onDocClick);
  }
}
