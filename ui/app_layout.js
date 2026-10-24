/**
 * ui/app_layout.js
 * 3D 모드 뷰어의 UI 레이아웃, Three.js 뷰포트, 상단 툴바, 우측 패널, 상태표시줄을 조립하고
 * 모드 로딩 및 실시간 조작 상태 동기화를 총괄하는 메인 오케스트레이터입니다.
 */

import { ModViewer3D } from '../core/viewer3d.js';
import { TogglePanel } from './toggle_panel.js';
import { IniDropdown } from './ini_dropdown.js';
import { ViewerToolbar } from './toolbar.js';
import { getActiveModFolder } from '../core/scanner.js';
import { loadModData, clearModDataCache } from '../core/mod_loader.js';
import { parseDdsTexture, loadImageTexture } from '../core/dds_decoder.js';
import {
  persistViewState,
  getPersistedViewState,
  clearPersistedFolder,
  createDefaultViewState,
} from '../core/state.js';

export { getActiveModFolder };

/**
 * [공통 UI 렌더러 함수]
 * 내장 서브 윈도우와 별도 OS 창 양쪽에서 공유하여 호출되는 3D 뷰어 레이아웃 및 렌더링 파이프라인
 * @param {HTMLElement} container - 루트 부착 컨테이너
 * @param {object} context - PluginContext 또는 NativeSubWindowContext
 * @param {string | null} initialFolder - 초기 모드 폴더 경로
 * @param {(folder: string | null, viewState?: any) => void} [onFolderChange] - 폴더 및 상태 변경 시 부모 창에 알릴 콜백
 * @param {object} [initialViewState] - 복원할 뷰어 조작 상태 (축, 토글 변수, INI 체크, 카메라)
 * @returns {() => void} 리소스 해제(cleanup) 함수
 */
export function render3DViewer(container, context, initialFolder, onFolderChange, initialViewState = null) {
  // 이미 컨테이너에 활성 뷰어가 마운트되어 있다면 새로 만들지 않고 loadFolder만 호출 (UI 무한 증식 방지)
  if (container.__modViewerInstance) {
    context.logger?.info('[3D 뷰어] 기존 뷰어 인스턴스가 감지되어 UI 재생성 대신 loadFolder만 호출합니다.');
    if (initialFolder) {
      container.__modViewerInstance.loadFolder(initialFolder, false, initialViewState);
    }
    return container.__modViewerInstance.destroy;
  }

  container.innerHTML = '';

  let currentFolder = initialFolder || getActiveModFolder(context) || null;
  let loadedFolder = null;
  let isLoading = false;
  let activeTogglePanel = null;
  let currentEntries = [];
  let currentDetectedTextures = [];

  const savedState = currentFolder ? getPersistedViewState(currentFolder) : null;
  let currentViewState = createDefaultViewState(savedState, initialViewState);

  const root = document.createElement('div');
  root.className = 'mod-viewer-subwindow';

  // 1. 좌측 INI 선택 드롭다운 컴포넌트
  const iniDropdown = new IniDropdown({
    onSelectionChange: (updatedEntries) => {
      currentEntries = updatedEntries;
      applyFilteredInis();
      saveAndNotifyViewState();
    },
  });

  // 2. 상단 툴바 컴포넌트
  let viewer = null;

  const toolbar = new ViewerToolbar({
    context,
    iniDropdown,
    viewState: currentViewState,
    onAxisChange: ({ up, forward, rawUp, rawForward }) => {
      currentViewState.upAxis = up;
      currentViewState.forwardAxis = forward;
      viewer?.setOrientation(rawUp, rawForward, true);
      context.logger?.info(`3D 뷰어 기준 축 변경: 위(Up)=${rawUp}, 앞(Forward)=${rawForward}`);
      saveAndNotifyViewState();
    },
    onToggle: (key, isActive) => {
      currentViewState[key] = isActive;
      if (key === 'isWireframe') viewer?.setWireframe(isActive);
      if (key === 'isGrid') viewer?.setGridVisible(isActive);
      if (key === 'isAutoRotate') viewer?.setAutoRotate(isActive);
      saveAndNotifyViewState();
    },
    onResetCamera: () => {
      viewer?.resetCamera();
      if (viewer?.getCameraState) {
        currentViewState.camera = viewer.getCameraState();
        saveAndNotifyViewState();
      }
    },
    onReload: () => {
      const latestFolder = getActiveModFolder(context) || currentFolder;
      clearModDataCache(latestFolder);
      loadAllModInis(latestFolder, true);
    },
  });
  root.appendChild(toolbar.element);

  // 3. 메인 바디 영역 (뷰포트 + 토글 패널)
  const mainBody = document.createElement('div');
  mainBody.className = 'viewer-main-body';

  const viewport = document.createElement('div');
  viewport.className = 'viewport-container';

  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'viewport-overlay-loading';
  loadingOverlay.innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-text" id="loading-status-text">모드 파일 및 3D 모델 버퍼를 분석하고 있습니다…</div>
  `;
  viewport.appendChild(loadingOverlay);

  const sidebar = document.createElement('div');
  sidebar.className = 'panel-sidebar';

  viewer = new ModViewer3D(viewport);

  // 카메라 조작 완료 시 시점 상태 자동 동기화
  if (viewer?.controls) {
    viewer.controls.addEventListener('end', () => {
      if (viewer?.getCameraState) {
        currentViewState.camera = viewer.getCameraState();
        saveAndNotifyViewState();
      }
    });
  }

  if (context.ui?.createSplitView) {
    const mainSplit = context.ui.createSplitView({
      direction: 'horizontal',
      initialSize: '72%',
      minFirstSize: 320,
      minSecondSize: 260,
      storageKey: 'mod_viewer_main_split',
      onResize: () => {
        viewer.onResize();
      },
    });

    mainSplit.firstPane.append(viewport);
    mainSplit.secondPane.append(sidebar);
    mainBody.appendChild(mainSplit.element || mainSplit.container);
  } else {
    mainBody.appendChild(viewport);
    mainBody.appendChild(sidebar);
  }

  root.appendChild(mainBody);

  // 4. 하단 상태표시줄 구성
  const statusbar = context.ui.createStatusBar({
    items: [
      { id: 'vertex', label: '버텍스', value: '-' },
      { id: 'tris', label: '삼각형', value: '-' },
      { id: 'parts', label: '파츠 수', value: '-' },
    ],
    rightItems: [
      { id: 'file', label: '모드 파일', value: '준비 완료' },
    ],
  });
  root.appendChild(statusbar.element || statusbar.getElement());

  container.appendChild(root);

  /**
   * 최신 뷰어 조작 상태(축, 버튼, 토글 변수, 체크박스, 카메라)를 localStorage, storage 및 부모 창에 동기화
   */
  function saveAndNotifyViewState(skipRemoteSync = false) {
    if (!currentFolder) return;

    currentViewState.upAxis = toolbar.getUpAxis();
    currentViewState.forwardAxis = toolbar.getForwardAxis();
    currentViewState.isWireframe = toolbar.isWireframeActive();
    currentViewState.isGrid = toolbar.isGridActive();
    currentViewState.isAutoRotate = toolbar.isAutoRotateActive();

    if (Array.isArray(currentEntries)) {
      const selectedMap = {};
      for (const e of currentEntries) {
        selectedMap[e.name] = Boolean(e.enabled);
      }
      currentViewState.selectedInis = selectedMap;
    }

    if (viewer?.activeVariables) {
      currentViewState.variables = { ...viewer.activeVariables };
    }

    if (viewer?.getCameraState) {
      currentViewState.camera = viewer.getCameraState();
    }

    // localStorage 및 context.storage에 영구 보존
    persistViewState(currentFolder, currentViewState);
    context.storage?.set?.(`mod_view_state_${currentFolder}`, currentViewState);

    // 부모 창 핸들러에 알림
    onFolderChange?.(currentFolder, currentViewState);

    // 별도 OS 창(WebviewWindow)인 경우 메인 창으로 채널 동기화 전송
    if (!skipRemoteSync && context.channel) {
      context.channel.postMessage({
        type: 'SYNC_VIEW_STATE',
        folder: currentFolder,
        viewState: currentViewState,
      });
    }
  }

  /**
   * 외부(별도 창 또는 부모 창)로부터 수신된 조작 상태를 현재 뷰어 및 UI에 즉시 반영
   * @param {object} incomingState
   * @param {boolean} [skipNotify=false]
   */
  function applyViewState(incomingState, skipNotify = false) {
    if (!currentFolder) return;
    if (!incomingState || typeof incomingState !== 'object') return;
    currentViewState = { ...currentViewState, ...incomingState };

    // 1. 툴바 UI 컨트롤 갱신
    toolbar.applyViewState(currentViewState);

    // 2. 뷰어 엔진 상태 갱신
    if (typeof currentViewState.isWireframe === 'boolean') viewer?.setWireframe(currentViewState.isWireframe);
    if (typeof currentViewState.isGrid === 'boolean') viewer?.setGridVisible(currentViewState.isGrid);
    if (typeof currentViewState.isAutoRotate === 'boolean') viewer?.setAutoRotate(currentViewState.isAutoRotate);

    // 3. 축 뷰어 갱신 (카메라 위치 강제 리셋 방지)
    const rawUp = String(currentViewState.upAxis || '+Y').split(' ')[0];
    const rawFwd = String(currentViewState.forwardAxis || '-Z').split(' ')[0];
    viewer?.setOrientation(rawUp, rawFwd, true);

    // 4. INI 선택 체크박스 상태 동기화
    if (currentViewState.selectedInis && currentEntries.length > 0) {
      let changed = false;
      for (const e of currentEntries) {
        if (currentViewState.selectedInis[e.name] !== undefined) {
          const newVal = Boolean(currentViewState.selectedInis[e.name]);
          if (e.enabled !== newVal) {
            e.enabled = newVal;
            changed = true;
          }
        }
      }
      if (changed) {
        const folderName = (currentFolder && typeof currentFolder === 'string')
          ? currentFolder.split('/').pop()
          : '모드';
        iniDropdown.setEntries(currentEntries, folderName);
        applyFilteredInis();
      }
    }

    // 5. 토글 변수 값 동기화
    if (currentViewState.variables && Object.keys(currentViewState.variables).length > 0) {
      if (viewer) {
        const { visibleTriangles, totalTriangles } = viewer.updateToggles(currentViewState.variables);
        statusbar.setValue('tris', `${visibleTriangles.toLocaleString()} / ${totalTriangles.toLocaleString()}`);
      }
      if (activeTogglePanel) {
        activeTogglePanel.currentValues = { ...activeTogglePanel.currentValues, ...currentViewState.variables };
        activeTogglePanel.render();
      }
    }

    // 6. 카메라 시점 복원
    if (currentViewState.camera && viewer) {
      viewer.setCameraState(currentViewState.camera);
    }

    if (currentFolder) {
      persistViewState(currentFolder, currentViewState);
    }

    if (!skipNotify) {
      saveAndNotifyViewState(true);
    }
  }

  /**
   * 빈 상태 표시 (모드 폴더 닫힘 시 메모리/UI 완전 폐기)
   */
  function showEmptyState(message = '열려있는 모드 폴더가 없습니다.') {
    // 1. 디스크 영구 저장소 및 메모리 캐시 완전 삭제
    clearPersistedFolder();
    clearModDataCache();

    // 2. 우측 토글 패널 및 메쉬 파츠 목록 리스너/DOM 완전 폐기
    if (activeTogglePanel) {
      activeTogglePanel.destroy?.();
      activeTogglePanel = null;
    }

    // 3. 뷰어 인스턴스 데이터 및 내부 상태 완전 초기화
    currentEntries = [];
    currentFolder = null;
    loadedFolder = null;
    currentViewState.variables = {};
    currentViewState.selectedInis = {};
    currentViewState.camera = null;
    viewer?.clearModel();
    viewer?.updateToggles?.({});
    iniDropdown.showEmpty();

    statusbar.setValue('file', '모드 폴더 없음');
    statusbar.setValue('vertex', '0');
    statusbar.setValue('tris', '0');
    statusbar.setValue('parts', '0');

    loadingOverlay.style.display = 'flex';
    const statusText = loadingOverlay.querySelector('.loading-text');
    if (statusText) {
      statusText.innerHTML = `
        <div style="font-size: 14px; color: #94a3b8; text-align: center; line-height: 1.6;">
          📂 ${message}<br>
          <span style="font-size: 12px; color: #64748b;">에디터 파일 탐색기에서 모드 폴더를 열면 자동으로 3D 모델이 로드됩니다.</span>
        </div>
      `;
    }

    // 4. 사이드바 DOM 완전 정리 (잔류 컨텐츠 영구 제거)
    sidebar.replaceChildren();
    sidebar.className = 'panel-sidebar';
    sidebar.innerHTML = `
      <div style="padding: 20px; color: #64748b; font-size: 12px; text-align: center;">
        모드가 로드되면 토글 컨트롤이 표시됩니다.
      </div>
    `;
  }

  /**
   * 선택된 INI 파일들의 컴포넌트/파츠/변수를 뷰어 및 사이드바에 적용
   */
  function applyFilteredInis() {
    const folderName = (currentFolder && typeof currentFolder === 'string')
      ? currentFolder.split('/').pop()
      : '모드';
    const enabledEntries = currentEntries.filter((e) => e.enabled);

    if (enabledEntries.length === 0) {
      viewer.clearModel();
      statusbar.setValue('file', `${folderName} (선택된 INI 없음)`);
      statusbar.setValue('vertex', '0');
      statusbar.setValue('tris', '0');
      statusbar.setValue('parts', '0');
      sidebar.innerHTML = `
        <div style="padding: 24px; color: #94a3b8; font-size: 13px; text-align: center; line-height: 1.6;">
          ⚠️ <b>반영할 INI 파일이 선택되지 않았습니다.</b><br>
          <span style="font-size: 12px; color: #64748b;">좌측 상단의 모드 드롭다운 버튼을 눌러 원하는 INI 파일을 체크하세요.</span>
        </div>
      `;
      return;
    }

    const mergedConstants = {};
    const mergedKeyBindings = {};
    const allComponents = [];
    const allParts = [];
    let totalVertexCount = 0;

    for (const entry of enabledEntries) {
      Object.assign(mergedConstants, entry.constants);
      Object.assign(mergedKeyBindings, entry.keyBindings);
      allComponents.push(...entry.components);
      allParts.push(...entry.parts);
      totalVertexCount += entry.vertexCount;
    }

    // 복원할 토글 변수값이 저장되어 있으면 병합 적용
    if (currentViewState.variables && Object.keys(currentViewState.variables).length > 0) {
      Object.assign(mergedConstants, currentViewState.variables);
    }

    if (allComponents.length === 0) {
      viewer.clearModel();
      sidebar.innerHTML = `
        <div style="padding: 24px; color: #94a3b8; font-size: 13px; text-align: center; line-height: 1.6;">
          선택된 INI 파일에 유효한 3D 메쉬 데이터가 없습니다.
        </div>
      `;
      statusbar.setValue('file', `${folderName} (${enabledEntries.map((e) => e.name).join(', ')})`);
      statusbar.setValue('vertex', '0');
      statusbar.setValue('tris', '0');
      statusbar.setValue('parts', '0');
      return;
    }

    viewer.setComponents(allComponents, mergedConstants);

    statusbar.setValue('file', `${folderName} (${enabledEntries.map((e) => e.name).join(', ')})`);
    statusbar.setValue('vertex', totalVertexCount.toLocaleString());
    statusbar.setValue('parts', `${allParts.length}개`);

    // 우측 토글 컨트롤 패널 바인딩 (파츠별 텍스처 변경 드롭다운 연동)
    activeTogglePanel = new TogglePanel(sidebar, {
      constants: mergedConstants,
      keyBindings: mergedKeyBindings,
      parts: allParts,
      detectedTextures: currentDetectedTextures,
      partTextures: currentViewState.customTextures || {},
      context,
      onChange: (updatedVars) => {
        const { visibleTriangles, totalTriangles } = viewer.updateToggles(updatedVars);
        statusbar.setValue('tris', `${visibleTriangles.toLocaleString()} / ${totalTriangles.toLocaleString()}`);
        currentViewState.variables = { ...viewer.activeVariables };
        saveAndNotifyViewState();
      },
      onTextureChange: async (part, chosenTextureFile) => {
        await handlePartTextureChange(part, chosenTextureFile);
      },
    });

    const { visibleTriangles, totalTriangles } = viewer.updateToggles(mergedConstants);
    statusbar.setValue('tris', `${visibleTriangles.toLocaleString()} / ${totalTriangles.toLocaleString()}`);

    // 저장된 파츠별 커스텀 텍스처 복원 적용
    if (currentViewState.customTextures && Object.keys(currentViewState.customTextures).length > 0) {
      for (const part of allParts) {
        const partKey = part.id || part.name;
        const customTex = currentViewState.customTextures[partKey];
        if (customTex) {
          handlePartTextureChange(part, customTex, true);
        }
      }
    }

    // 이전 카메라 시점 복원
    if (currentViewState.camera) {
      viewer.setCameraState(currentViewState.camera);
    }

    context.logger?.info(`[3D 뷰어] 선택된 ${enabledEntries.length}개 INI 즉시 반영 완료 (${allComponents.length}개 메쉬, ${allParts.length}개 파츠)`);
  }

  /**
   * 파츠별 텍스처 파일 실시간 로드 및 Three.js 메쉬에 적용
   * @param {any} part
   * @param {string} texFileName
   * @param {boolean} [skipNotify=false]
   */
  async function handlePartTextureChange(part, texFileName, skipNotify = false) {
    if (!currentFolder) return;
    const partKey = part.id || part.name;
    if (!currentViewState.customTextures) currentViewState.customTextures = {};

    if (!texFileName) {
      delete currentViewState.customTextures[partKey];
      viewer?.setPartTexture(partKey, null, null);
      if (!skipNotify) saveAndNotifyViewState();
      return;
    }

    try {
      context.logger?.info(`[3D 뷰어] 파츠 [${part.name}] 텍스처 변경 요청: ${texFileName}`);
      const normFolder = currentFolder.replace(/\\/g, '/');
      const targetPath = `${normFolder}/${texFileName}`;

      const bytes = await context.workspace.readBinaryFile(targetPath);
      const isNormal = /normal|norm/i.test(texFileName);
      if (texFileName.toLowerCase().endsWith('.dds')) {
        newTex = parseDdsTexture(bytes, context, viewer?.renderer, { isNormal, isDiffuse: !isNormal });
      } else {
        const mime = texFileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        newTex = await loadImageTexture(bytes, mime, !isNormal);
      }

      viewer?.setPartTexture(partKey, newTex, texFileName);
      currentViewState.customTextures[partKey] = texFileName;
      if (!skipNotify) saveAndNotifyViewState();
      context.logger?.info(`[3D 뷰어] 파츠 [${part.name}] 텍스처 반영 완료 (${texFileName})`);
    } catch (err) {
      context.logger?.warn(`[3D 뷰어] 텍스처 로드 경고 (${texFileName}):`, err);
    }
  }

  /**
   * 모드 통합 로딩 파이프라인 (메모리 캐시 연동)
   */
  async function loadAllModInis(rawFolder, forceReload = false, incomingViewState = null) {
    const targetFolder = typeof rawFolder === 'string' ? rawFolder : (rawFolder?.folder || null);
    if (!targetFolder || typeof targetFolder !== 'string') {
      showEmptyState();
      return;
    }

    const normalizedFolder = targetFolder.replace(/\\/g, '/');

    // 다른 모드 폴더로 전환 시 이전 모드의 변수/INI 선택/카메라가 새 모드로 새어 들어가지 않게 초기화
    if (loadedFolder && normalizedFolder !== loadedFolder) {
      if (activeTogglePanel) {
        activeTogglePanel.destroy?.();
        activeTogglePanel = null;
      }
      currentViewState.variables = {};
      currentViewState.selectedInis = {};
      currentViewState.camera = null;
    }

    if (incomingViewState) {
      currentViewState = { ...currentViewState, ...incomingViewState };
    }

    if (!forceReload && normalizedFolder === loadedFolder && currentEntries.length > 0 && !isLoading) {
      context.logger?.debug(`[3D 뷰어] 이미 로드 완료된 폴더입니다: ${normalizedFolder}`);
      return;
    }

    if (isLoading) {
      context.logger?.debug(`[3D 뷰어] 이전 폴더 로딩 진행 중입니다. 요청 대기: ${normalizedFolder}`);
      return;
    }

    isLoading = true;
    currentFolder = normalizedFolder;
    loadingOverlay.style.display = 'flex';
    const statusText = loadingOverlay.querySelector('.loading-text');

    try {
      // storage 및 localStorage에 저장된 이전 상태 복원 시도
      if (!incomingViewState) {
        const persisted = getPersistedViewState(currentFolder);
        const savedState = persisted || await context.storage?.get?.(`mod_view_state_${currentFolder}`);
        if (savedState) {
          currentViewState = { ...currentViewState, ...savedState };
        }
      }

      // 메모리 캐시 및 크로스 윈도우 동기화를 우선 활용하여 로딩 단축
      const { iniFiles, parsedIniEntries, totalMeshComponents, detectedTextures } = await loadModData({
        folder: currentFolder,
        context,
        viewer,
        forceReload,
        onProgress: (msg) => {
          if (statusText) statusText.textContent = msg;
        },
      });
      currentDetectedTextures = detectedTextures || [];

      if (iniFiles.length === 0) {
        showEmptyState(`폴더 내에 .ini 파일이 없습니다: ${currentFolder}`);
        loadedFolder = currentFolder;
        return;
      }

      if (totalMeshComponents === 0) {
        showEmptyState(`INI 파일은 발견되었으나 표시 가능한 3D 버퍼(.buf / .ib)를 찾지 못했습니다.`);
        loadedFolder = currentFolder;
        return;
      }

      currentEntries = parsedIniEntries;

      // 이전 INI 선택 체크박스 상태 복원
      if (currentViewState.selectedInis && Object.keys(currentViewState.selectedInis).length > 0) {
        for (const entry of currentEntries) {
          if (currentViewState.selectedInis[entry.name] !== undefined) {
            entry.enabled = Boolean(currentViewState.selectedInis[entry.name]);
          }
        }
      }

      const folderName = (currentFolder && typeof currentFolder === 'string')
        ? currentFolder.split('/').pop()
        : '모드';
      iniDropdown.setEntries(currentEntries, folderName);

      // 컨트롤 UI 상태(축, 버튼) 동기화
      toolbar.applyViewState(currentViewState);

      // 축 적용
      const upVal = currentViewState.upAxis || '+Y';
      const fwdVal = currentViewState.forwardAxis || '-Z';
      viewer?.setOrientation(String(upVal).split(' ')[0], String(fwdVal).split(' ')[0]);

      // 메쉬 렌더링 및 변수/카메라 복원
      applyFilteredInis();

      loadingOverlay.style.display = 'none';
      loadedFolder = currentFolder;
      context.logger?.info(`[3D 뷰어] 모드 통합 로드 완료 (${folderName}): ${iniFiles.length}개 INI 파일 스캔됨, ${totalMeshComponents}개 컴포넌트`);
      context.ui?.showToast?.(`[${folderName}] 모드(INI ${iniFiles.length}개)가 성공적으로 로드되었습니다.`, 'info');

      // 최종 상태 동기화
      saveAndNotifyViewState();
    } catch (err) {
      context.logger?.error(`3D 모드 통합 로드 실패 (${targetFolder}):`, err);
      statusText.innerHTML = `
        <div style="color: #ef4444; font-weight: 600; margin-bottom: 8px;">❌ 모드 로드 실패</div>
        <div style="font-size: 12px; color: #cbd5e1;">${err.message || String(err)}</div>
      `;
      context.ui?.showToast?.(`3D 뷰어 로드 실패: ${err.message}`, 'error');
    } finally {
      isLoading = false;
    }
  }

  // 최초 로드 실행
  if (currentFolder) {
    loadAllModInis(currentFolder, false, currentViewState);
  } else {
    showEmptyState('열려있는 모드 폴더가 없습니다.');
  }

  // 5. 에디터 생명주기 및 워크스페이스 이벤트 리스너
  const isNativeWindow = Boolean(context.channel);
  let unlistenActiveFolder = null;
  let unlistenClearMemory = null;
  let unlistenSaveFile = null;
  let unlistenTheme = null;
  let folderWatcherTimer = null;
  let onWindowFocus = null;

  // 에디터 테마 초기 반영 및 실시간 변경 감지
  if (context.ui?.getTheme && viewer?.setTheme) {
    viewer.setTheme(context.ui.getTheme());
  }
  unlistenTheme = context.ui?.onDidChangeTheme?.(({ theme }) => {
    context.logger?.info(`[3D 뷰어] 에디터 테마 변경 감지: ${theme}`);
    viewer?.setTheme?.(theme);
  });

  // 코어 작업 영역 초기화 및 메모리 해제 이벤트 실시간 감지 (모드 폴더 닫기/변경/리셋)
  unlistenClearMemory = context.workspace?.onDidClearMemory?.(({ reason }) => {
    context.logger?.info(`[3D 뷰어] onDidClearMemory 수신 (사유: ${reason}) -> 3D 캐시 및 UI 완전 폐기`);
    showEmptyState('열려있는 모드 폴더가 없습니다.');
    onFolderChange?.(null, null);
  });

  // 코어 슬롯 매칭 엔진의 텍스처/부위 매칭 실시간 변경 감지
  let unlistenSlots = null;
  unlistenSlots = context.slots?.onDidChangeSlots?.((slots) => {
    if (!currentFolder) return;
    context.logger?.info(`[3D 뷰어] 슬롯 매칭 변경 감지 (${slots.length}개 부위) -> 뷰어 텍스처 및 모델 자동 갱신`);
    clearModDataCache(currentFolder);
    loadAllModInis(currentFolder, true);
  });

  // 에디터 파일 저장 완료 감지 (INI 파일 변경 시 뷰어 실시간 자동 갱신)
  unlistenSaveFile = context.workspace?.onDidSaveFile?.(({ path, name }) => {
    if (!currentFolder || !path) return;
    const normPath = String(path).replace(/\\/g, '/').toLowerCase();
    const normFolder = String(currentFolder).replace(/\\/g, '/').toLowerCase();
    if (normPath.startsWith(normFolder) && (normPath.endsWith('.ini') || normPath.endsWith('.buf') || normPath.endsWith('.dds'))) {
      context.logger?.info(`[3D 뷰어] 모드 파일 저장 감지 (${name}) -> 캐시 무효화 및 3D 모델 자동 갱신`);
      clearModDataCache(currentFolder);
      loadAllModInis(currentFolder, true);
    }
  });

  if (!isNativeWindow) {
    function checkAndUpdateModFolder() {
      const latestFolder = getActiveModFolder(context);
      if (!latestFolder) {
        if (currentFolder || loadedFolder || currentEntries.length > 0) {
          context.logger?.info('미고토 스튜디오에서 모드 폴더가 닫힘 감지. 메모리 및 UI 완전 초기화');
          currentFolder = null;
          loadedFolder = null;
          showEmptyState('열려있는 모드 폴더가 없습니다.');
          onFolderChange?.(null, null);
        }
        return;
      }

      if (latestFolder !== currentFolder && latestFolder !== loadedFolder) {
        context.logger?.info(`모드 폴더 변경 감지 (${currentFolder || '없음'} -> ${latestFolder}) -> 3D 뷰어 자동 갱신`);
        currentFolder = latestFolder;
        persistViewState(currentFolder, currentViewState);
        context.storage?.set?.('last_active_mod_folder', currentFolder);
        loadAllModInis(currentFolder);
      }
    }

    unlistenActiveFolder = context.workspace?.onDidChangeActiveFolder?.((folder) => {
      context.logger?.info(`[3D 뷰어] onDidChangeActiveFolder 수신: ${folder}`);
      checkAndUpdateModFolder();
    });

    folderWatcherTimer = setInterval(() => {
      checkAndUpdateModFolder();
    }, 1000);

    onWindowFocus = () => {
      checkAndUpdateModFolder();
    };
    window.addEventListener('focus', onWindowFocus);
  }

  // 정리 함수
  function destroy() {
    context.logger?.info('3D 모드 뷰어가 종료되었습니다. 리소스를 정리합니다.');
    saveAndNotifyViewState();
    iniDropdown.destroy();
    if (folderWatcherTimer) clearInterval(folderWatcherTimer);
    if (typeof unlistenActiveFolder === 'function') unlistenActiveFolder();
    if (typeof unlistenClearMemory === 'function') unlistenClearMemory();
    if (typeof unlistenSaveFile === 'function') unlistenSaveFile();
    if (typeof unlistenSlots === 'function') unlistenSlots();
    if (typeof unlistenTheme === 'function') unlistenTheme();
    if (onWindowFocus) window.removeEventListener('focus', onWindowFocus);
    viewer?.destroy();
    if (container.__modViewerInstance === instance) {
      container.__modViewerInstance = null;
    }
    root.remove();
  }

  const instance = {
    loadFolder: (folder, force = false, viewState = null) => {
      if (!folder) {
        showEmptyState('열려있는 모드 폴더가 없습니다.');
        return;
      }
      return loadAllModInis(folder, force, viewState);
    },
    getViewState: () => currentViewState,
    applyViewState: (state, skipNotify = false) => applyViewState(state, skipNotify),
    destroy,
  };
  container.__modViewerInstance = instance;

  return destroy;
}
