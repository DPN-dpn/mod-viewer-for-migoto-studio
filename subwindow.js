/**
 * subwindow.js
 * Migoto Studio 3D 모드 뷰어의 윈도우 생명주기 및 PiP(별도 OS 창) 연동 엔트리포인트입니다.
 * UI 레이아웃 로직은 ./ui/app_layout.js 로 완전히 모듈화되어 분리되었습니다.
 */

import './style.css';
import { render3DViewer, getActiveModFolder } from './ui/app_layout.js';
import {
  persistViewState,
  getPersistedViewState,
  clearPersistedFolder,
} from './core/state.js';

export { render3DViewer, getActiveModFolder };

/**
 * [별도 OS 윈도우 진입점]
 * 서브 윈도우 상단 PiP 버튼(⧉) 클릭으로 분리되었거나, openNativeWindow로 실행될 때 자동 호출됩니다.
 * @param {object} nativeContext - { container, workspace, initialData, channel, logger, ui, storage }
 */
export default async function runInNativeWindow(nativeContext) {
  nativeContext.logger?.info('3D 모드 뷰어 데스크톱 독립 OS 창(WebviewWindow)이 시작되었습니다.');

  // 독립 OS 창 환경에서 plugins 객체 누락 방어
  if (!nativeContext.plugins) {
    nativeContext.plugins = {
      getPluginApi(pluginId) {
        return window.__migoto_plugin_apis?.[pluginId];
      },
    };
  }

  // 메인 창에서 명시적으로 전달받은 initialData의 folder만 사용 (닫힌 폴더 자동 되살리기 금지)
  const folder = nativeContext.initialData?.folder || null;
  const initialViewState = nativeContext.initialData?.viewState || (folder ? getPersistedViewState(folder) : null) || null;

  const cleanup = render3DViewer(nativeContext.container, nativeContext, folder, (updatedFolder, updatedState) => {
    if (nativeContext.channel) {
      nativeContext.channel.postMessage({
        type: 'SYNC_VIEW_STATE',
        folder: updatedFolder,
        viewState: updatedState,
      });
    }
  }, initialViewState);

  if (nativeContext.channel) {
    nativeContext.channel.onMessage((msg) => {
      if (!msg) return;

      if (msg.type === 'INIT_DATA' || msg.type === 'UPDATE_INITIAL_DATA') {
        const nextFolder = msg.data?.folder || msg.folder;
        const nextViewState = msg.data?.viewState || msg.viewState;
        if (nextFolder) {
          nativeContext.logger?.info(`메인 창으로부터 초기 데이터 수신: ${nextFolder}`);
          if (nativeContext.container.__modViewerInstance) {
            nativeContext.container.__modViewerInstance.loadFolder(nextFolder, false, nextViewState);
          }
        }
      } else if (msg.type === 'CHANGE_FOLDER') {
        const nextFolder = msg.folder;
        const nextViewState = msg.viewState;
        if (nextFolder) {
          nativeContext.logger?.info(`메인 창으로부터 대상 폴더 변경 알림 수신: ${nextFolder}`);
          if (nativeContext.container.__modViewerInstance) {
            nativeContext.container.__modViewerInstance.loadFolder(nextFolder, false, nextViewState);
          }
        } else if (msg.folder === null || msg.folder === '') {
          nativeContext.logger?.info('메인 창으로부터 모드 폴더 닫힘 수신');
          if (nativeContext.container.__modViewerInstance) {
            nativeContext.container.__modViewerInstance.loadFolder(null);
          }
        }
      } else if (msg.type === 'SYNC_VIEW_STATE' && msg.viewState) {
        if (nativeContext.container.__modViewerInstance?.applyViewState) {
          nativeContext.container.__modViewerInstance.applyViewState(msg.viewState, true);
        }
      }
    });
  }

  // 창 포커스 시 localStorage의 최신 조작 상태 실시간 동기화
  const onFocusSync = () => {
    const currentActiveFolder = nativeContext.container?.__modViewerInstance?.getViewState?.()?.folder || null;
    if (currentActiveFolder) {
      const latestState = getPersistedViewState(currentActiveFolder);
      if (latestState && nativeContext.container?.__modViewerInstance?.applyViewState) {
        nativeContext.container.__modViewerInstance.applyViewState(latestState, true);
      }
    }
  };
  window.addEventListener('focus', onFocusSync);

  window.addEventListener('beforeunload', () => {
    window.removeEventListener('focus', onFocusSync);
    if (typeof cleanup === 'function') {
      cleanup();
    }
  });
}

let activeSubWindow = null;

/**
 * [내장 서브 윈도우 진입점]
 * 상단 메인 메뉴바의 [플러그인] 메뉴에서 3D 모드 뷰어를 열 때 호출됩니다.
 * @param {object} context - PluginContext
 */
export async function open3DViewerSubWindow(context) {
  // 이미 열려 있는 서브 윈도우가 있다면 포커스하고 반환 (중복 창 생성 방지)
  if (activeSubWindow) {
    context.logger?.info('3D 모드 뷰어가 이미 열려 있습니다. 기존 창을 포커스합니다.');
    try {
      activeSubWindow.focus?.();
      return activeSubWindow;
    } catch {
      activeSubWindow = null;
    }
  }

  const folder = getActiveModFolder(context) || null;
  const lastViewState = folder ? (getPersistedViewState(folder) || await context.storage?.get?.(`mod_view_state_${folder}`)) : null;

  context.logger?.info(`3D 모드 뷰어 서브 윈도우 생성 (대상 폴더: ${folder || '미지정'})`);

  if (folder) {
    persistViewState(folder, lastViewState);
    context.storage?.set?.('last_active_mod_folder', folder);
  }

  let currentSubWin = null;
  let activeViewState = lastViewState;
  let subWinContainerRef = null;
  let unlistenGlobalFolder = null;
  let unlistenClearMemory = null;

  currentSubWin = context.ui.openSubWindow({
    id: 'mod-3d-viewer-window',
    title: '3D 모드 뷰어 - Migoto Studio',
    width: 1060,
    height: 740,
    minWidth: 640,
    minHeight: 480,
    maximized: true,
    resizable: true,
    focusMode: 'parentLinked',
    entry: 'subwindow.js',
    initialData: {
      folder,
      viewState: activeViewState,
    },
    render(container, handle) {
      subWinContainerRef = container;

      // 서브 윈도우 타이틀바의 기존 '최대화/복원' 버튼을 기본 켜놓기
      const triggerMaximize = () => {
        try {
          if (typeof handle?.maximize === 'function') {
            handle.maximize();
            return;
          }
          if (typeof currentSubWin?.maximize === 'function') {
            currentSubWin.maximize();
            return;
          }

          const winEl = container.closest?.('.sub-window, .subwindow, .floating-window, [class*="window"], [class*="dialog"]') || container.parentElement;
          if (!winEl) return;

          // 이미 최대화 상태이면 패스
          if (winEl.classList.contains('maximized') || winEl.classList.contains('is-maximized')) return;

          const maxBtn = winEl.querySelector?.(
            'button[title*="최대화"], button[aria-label*="최대화"], button[title*="Maximize"], button[aria-label*="Maximize"], .btn-maximize, .window-maximize, [class*="maximize"]'
          );

          if (maxBtn) {
            maxBtn.click();
          } else {
            const header = winEl.querySelector?.('[class*="header"], [class*="titlebar"], [class*="title-bar"]') || winEl.firstElementChild;
            const btns = header ? Array.from(header.querySelectorAll('button')) : [];
            if (btns.length >= 2) {
              const candidate = btns[btns.length - 2];
              if (candidate && !candidate.title?.includes?.('닫기') && !candidate.classList?.contains?.('close')) {
                candidate.click();
              }
            }
          }
        } catch {
          // ignore
        }
      };

      requestAnimationFrame(triggerMaximize);
      setTimeout(triggerMaximize, 50);

      // PiP에서 Dock In으로 복귀했을 때 이미 인스턴스가 살아있으면 최신 activeViewState를 즉시 적용
      if (container.__modViewerInstance) {
        if (activeViewState && container.__modViewerInstance.applyViewState) {
          container.__modViewerInstance.applyViewState(activeViewState, true);
        }
        return () => {
          cleanupSubWindow();
          container.__modViewerInstance?.destroy?.();
        };
      }

      const viewerCleanup = render3DViewer(container, context, folder, (updatedFolder, updatedState) => {
        if (updatedState) activeViewState = updatedState;
        if (handle) {
          handle.setInitialData?.({ folder: updatedFolder, viewState: activeViewState });
          handle.postMessage?.({ type: 'CHANGE_FOLDER', folder: updatedFolder, viewState: activeViewState });
        }
        if (currentSubWin) {
          currentSubWin.setInitialData?.({ folder: updatedFolder, viewState: activeViewState });
          currentSubWin.postMessage?.({ type: 'CHANGE_FOLDER', folder: updatedFolder, viewState: activeViewState });
        }
      }, activeViewState);

      return () => {
        cleanupSubWindow();
        if (typeof viewerCleanup === 'function') {
          viewerCleanup();
        }
      };
    },
  });

  activeSubWindow = currentSubWin;

  // 서브 윈도우 생성 직후 최대화 호출
  try {
    if (typeof currentSubWin?.maximize === 'function') {
      currentSubWin.maximize();
    }
  } catch (e) {
    // ignore
  }

  // 서브 윈도우 전용 이벤트 및 리소스 해제 함수
  function cleanupSubWindow() {
    window.removeEventListener('focus', onMainFocus);
    if (typeof unlistenGlobalFolder === 'function') {
      unlistenGlobalFolder();
      unlistenGlobalFolder = null;
    }
    if (typeof unlistenClearMemory === 'function') {
      unlistenClearMemory();
      unlistenClearMemory = null;
    }
    if (activeSubWindow === currentSubWin) {
      activeSubWindow = null;
    }
  }

  // 서브윈도우 및 PiP 독립 창으로부터 올라온 메시지 수신 (상태 실시간 동기화)
  if (currentSubWin?.onMessage) {
    currentSubWin.onMessage((msg) => {
      if (msg?.type === 'SYNC_VIEW_STATE' && msg.viewState) {
        activeViewState = msg.viewState;
        if (msg.folder) {
          persistViewState(msg.folder, activeViewState);
          context.storage?.set?.(`mod_view_state_${msg.folder}`, activeViewState);
        }
        currentSubWin.setInitialData?.({ folder: msg.folder || folder, viewState: activeViewState });

        // ★ 메인 창에 열려 있는 뷰어 인스턴스에도 실시간으로 조작 상태 반영!
        if (subWinContainerRef?.__modViewerInstance?.applyViewState) {
          subWinContainerRef.__modViewerInstance.applyViewState(activeViewState, true);
        }
      }
    });
  }

  // 메인 창이 다시 활성화/포커스될 때(PiP 창 닫고 돌아오기 등) 최신 상태 자동 반영
  const onMainFocus = () => {
    const currentActiveFolder = getActiveModFolder(context);
    if (!currentActiveFolder) {
      // 모드 폴더가 닫혀있으면 아무것도 복원하지 않음 (오히려 비어있어야 함)
      return;
    }
    const latestState = getPersistedViewState(currentActiveFolder);
    if (latestState) {
      activeViewState = latestState;
      if (subWinContainerRef?.__modViewerInstance?.applyViewState) {
        subWinContainerRef.__modViewerInstance.applyViewState(latestState, true);
      }
    }
  };
  window.addEventListener('focus', onMainFocus);

  const notifyFolderChange = (newFolder) => {
    if (newFolder) {
      persistViewState(newFolder, activeViewState);
      context.storage?.set?.('last_active_mod_folder', newFolder);
      if (subWinContainerRef?.__modViewerInstance) {
        subWinContainerRef.__modViewerInstance.loadFolder(newFolder, false, activeViewState);
      }
    } else {
      clearPersistedFolder();
      context.storage?.remove?.('last_active_mod_folder');
      activeViewState = null;
      if (subWinContainerRef?.__modViewerInstance) {
        subWinContainerRef.__modViewerInstance.loadFolder(null);
      }
    }
    if (currentSubWin) {
      currentSubWin.setInitialData?.({ folder: newFolder, viewState: activeViewState });
      currentSubWin.postMessage?.({ type: 'CHANGE_FOLDER', folder: newFolder, viewState: activeViewState });
    }
  };

  // ★ 오직 모드 폴더 변경 시에만 반응 (ini 파일 탭 열림/닫힘은 일체 무시)
  unlistenGlobalFolder = context.workspace?.onDidChangeActiveFolder?.((newFolder) => {
    context.logger?.info(`[3D 뷰어] 메인 창 모드 폴더 변경 감지: ${newFolder}`);
    notifyFolderChange(newFolder);
  });

  // 코어 작업 영역 초기화 및 메모리 해제 이벤트(onDidClearMemory) 연동
  unlistenClearMemory = context.workspace?.onDidClearMemory?.(({ reason }) => {
    context.logger?.info(`[3D 뷰어] 메인 창 onDidClearMemory 수신 (${reason}) -> 서브윈도우 뷰어 완전 초기화`);
    notifyFolderChange(null);
  });

  return currentSubWin;
}

/**
 * 활성 서브 윈도우 외부 강제 닫기 (플러그인 비활성화 시 등)
 */
export function close3DViewerSubWindow() {
  if (activeSubWindow) {
    try {
      activeSubWindow.close?.();
    } catch {}
    activeSubWindow = null;
  }
}
