/**
 * index.js
 * 3D 모드 뷰어 플러그인 엔트리 포인트
 * Migoto Studio 코어 생명주기 및 메모리 관리 API와 완벽하게 연동됩니다.
 */

import { open3DViewerSubWindow, close3DViewerSubWindow } from './subwindow.js';
import { clearModDataCache } from './core/mod_loader.js';
import { clearPersistedFolder } from './core/state.js';

let unlistenCoreClearMemory = null;

export default {
  activate(context) {
    context.logger?.info('3D 모드 뷰어 플러그인이 활성화되었습니다.');

    // 1. 상단 툴바 [플러그인] 메뉴에 등록
    context.ui.registerMenuItem({
      label: '3D 모드 뷰어 열기',
      shortcut: 'Ctrl+Shift+V',
      action: () => {
        open3DViewerSubWindow(context);
      },
    });

    // 2. 코어 레벨 작업 영역 초기화 및 메모리 해제 이벤트 등록
    // 서브윈도우가 닫혀있더라도 플러그인 자체 메모리 캐시 누수를 원천 차단
    unlistenCoreClearMemory = context.workspace?.onDidClearMemory?.(({ reason }) => {
      context.logger?.info(`[3D 뷰어 플러그인] 코어 메모리 해제 알림 수신 (reason: ${reason}) -> 3D 데이터 캐시 및 상태 완전 초기화`);
      clearModDataCache();
      clearPersistedFolder();
    });

    context.ui.showToast('3D 모드 뷰어가 준비되었습니다. [플러그인] 메뉴 또는 Ctrl+Shift+V로 열 수 있습니다.', 'info');
  },

  deactivate(context) {
    context?.logger?.info('3D 모드 뷰어 플러그인이 비활성화되었습니다. 모든 리소스를 해제합니다.');

    // 1. 열려 있는 서브 윈도우 안전하게 닫기
    close3DViewerSubWindow();

    // 2. 전역 이벤트 리스너 해제
    if (typeof unlistenCoreClearMemory === 'function') {
      unlistenCoreClearMemory();
      unlistenCoreClearMemory = null;
    }

    // 3. 3D 모델 및 바이너리 버퍼 메모리 캐시 전체 폐기
    clearModDataCache();
  },
};
