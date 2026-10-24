/**
 * core/state.js
 * 3D 모드 뷰어의 조작 상태(축, 토글 버튼, 변수, INI 선택, 카메라 시점)를
 * localStorage 및 Plugin Storage에 영구 보존하고 동기화하는 상태 관리 모듈입니다.
 */

export const STORAGE_PREFIX = 'migoto_3d_view_state_';
export const STORAGE_LAST_FOLDER = 'migoto_3d_last_folder';

/**
 * 특정 모드 폴더의 영구 저장된 조작 상태 조회
 * @param {string | null} folder
 * @returns {object | null}
 */
export function getPersistedViewState(folder) {
  if (!folder) return null;
  try {
    const norm = String(folder).replace(/\\/g, '/');
    const raw = window.localStorage?.getItem(STORAGE_PREFIX + norm);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

/**
 * 특정 모드 폴더의 조작 상태를 localStorage에 영구 보존
 * @param {string | null} folder
 * @param {object} state
 */
export function persistViewState(folder, state) {
  if (!folder || !state) return;
  try {
    const norm = String(folder).replace(/\\/g, '/');
    window.localStorage?.setItem(STORAGE_PREFIX + norm, JSON.stringify(state));
    window.localStorage?.setItem(STORAGE_LAST_FOLDER, norm);
  } catch {}
}

/**
 * 마지막으로 활성화되었던 모드 폴더 경로 조회
 * @returns {string | null}
 */
export function getPersistedLastFolder() {
  try {
    return window.localStorage?.getItem(STORAGE_LAST_FOLDER) || null;
  } catch {}
  return null;
}

/**
 * 활성 모드 폴더 기록 완전 제거 (모드 폴더 닫힘 시)
 */
export function clearPersistedFolder() {
  try {
    window.localStorage?.removeItem(STORAGE_LAST_FOLDER);
  } catch {}
}

/**
 * 기본 뷰어 조작 상태 객체 생성 및 복원 병합
 * @param {object} [savedState]
 * @param {object} [initialViewState]
 * @returns {object}
 */
export function createDefaultViewState(savedState = null, initialViewState = null) {
  return {
    upAxis: '+Y (기본)',
    forwardAxis: '-Z (기본)',
    isWireframe: false,
    isGrid: true,
    isAutoRotate: false,
    selectedInis: {}, // { [iniName]: boolean }
    variables: {},    // { [varName]: number }
    customTextures: {}, // { [partId]: textureFileName }
    camera: null,     // { position, target, zoom }
    ...(savedState || {}),
    ...(initialViewState || {}),
  };
}
