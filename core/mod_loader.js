/**
 * core/mod_loader.js
 * 모드 디렉터리 내의 모든 INI 파일들을 순회 파싱하고,
 * 3DMigoto/XXMI .buf(바이너리) 및 .ib 버퍼, DDS/이미지 텍스처를 안전하게 해석/로드합니다.
 * 또한 BroadcastChannel을 통해 메인 창과 별도 OS 창 간에 디코딩된 3D 메쉬 데이터를 인스턴트 공유합니다.
 */

import { parseModIni } from './ini_parser.js';
import { parsePositionBuffer, parseTexcoordBuffer, parseIndexBuffer } from './buffer_loader.js';
import { parseDdsTexture, loadImageTexture } from './dds_decoder.js';
import { scanModDirectory } from './scanner.js';

// 폴더별 파싱 및 디코딩된 3D 모드 데이터 메모리 캐시 (중복 로딩 원천 방지)
const modDataCache = new Map();

// 메인 창 ↔ 별도 OS 창 간 3D 모델 데이터 즉시 공유 채널
const cacheSyncChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('migoto_3d_mod_cache_sync')
  : null;

if (cacheSyncChannel) {
  cacheSyncChannel.onmessage = (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'REQUEST_CACHE' && msg.folder) {
      const cached = modDataCache.get(msg.folder);
      if (cached) {
        try {
          const serialized = serializeForSync(cached);
          cacheSyncChannel.postMessage({
            type: 'RESPONSE_CACHE',
            folder: msg.folder,
            data: serialized,
          });
        } catch (e) {
          console.warn('[3D 뷰어 캐시 동기화] 직렬화 실패:', e);
        }
      }
    }
  };
}

/**
 * 다른 창(메인 창 또는 PiP 창)에 이미 로드된 3D 모드 캐시가 있는지 요청
 * @param {string} folder
 * @param {any} viewer
 * @returns {Promise<any | null>}
 */
function requestCacheFromOtherWindow(folder, viewer, context = null) {
  if (!cacheSyncChannel) return Promise.resolve(null);

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (cacheSyncChannel) cacheSyncChannel.removeEventListener('message', listener);
        resolve(null);
      }
    }, 200);

    const listener = (event) => {
      const msg = event.data;
      if (msg?.type === 'RESPONSE_CACHE' && msg.folder === folder && msg.data) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cacheSyncChannel.removeEventListener('message', listener);
          try {
            const restored = deserializeForSync(msg.data, viewer, context);
            resolve(restored);
          } catch (err) {
            console.warn('[3D 뷰어 캐시 동기화] 역직렬화 실패:', err);
            resolve(null);
          }
        }
      }
    };

    cacheSyncChannel.addEventListener('message', listener);
    cacheSyncChannel.postMessage({ type: 'REQUEST_CACHE', folder });
  });
}

/**
 * Three.js 텍스처 객체를 제외하고 TypedArray와 원본 바이트만 구조화 복제용으로 추출
 */
function serializeForSync(cacheEntry) {
  return {
    iniFiles: cacheEntry.iniFiles,
    totalMeshComponents: cacheEntry.totalMeshComponents,
    parsedIniEntries: cacheEntry.parsedIniEntries.map((entry) => ({
      ...entry,
      components: entry.components.map((c) => ({
        name: c.name,
        iniName: c.iniName,
        positions: c.positions,
        uvs: c.uvs,
        indices: c.indices,
        parts: c.parts,
        diffuseBytes: c.diffuseBytes || null,
        normalBytes: c.normalBytes || null,
        diffuseIsDds: Boolean(c.diffuseIsDds),
      })),
    })),
  };
}

/**
 * 수신한 구조화 데이터를 바탕으로 Three.js 텍스처를 재생성하여 캐시 복원
 */
function deserializeForSync(serialized, viewer, context = null) {
  const parsedIniEntries = serialized.parsedIniEntries.map((entry) => {
    const components = entry.components.map((c) => {
      let diffuseTexture = null;
      let normalTexture = null;

      if (c.diffuseBytes) {
        try {
          if (c.diffuseIsDds) {
            diffuseTexture = parseDdsTexture(c.diffuseBytes, context, viewer?.renderer, { isDiffuse: true, isNormal: false });
          }
        } catch (e) {
          console.warn('[3D 뷰어 캐시 복원] Diffuse 복원 실패:', e);
        }
      }

      if (c.normalBytes) {
        try {
          normalTexture = parseDdsTexture(c.normalBytes, context, viewer?.renderer, { isDiffuse: false, isNormal: true });
        } catch (e) {
          console.warn('[3D 뷰어 캐시 복원] Normal 복원 실패:', e);
        }
      }

      return {
        ...c,
        diffuseTexture,
        normalTexture,
      };
    });

    return {
      ...entry,
      components,
    };
  });

  return {
    iniFiles: serialized.iniFiles,
    totalMeshComponents: serialized.totalMeshComponents,
    parsedIniEntries,
  };
}

/**
 * 특정 폴더 또는 전체 모드 데이터 캐시 초기화
 * @param {string} [folder]
 */
export function clearModDataCache(folder) {
  if (folder) {
    modDataCache.delete(folder.replace(/\\/g, '/'));
  } else {
    modDataCache.clear();
  }
}

/**
 * 모드 폴더 전체를 스캔하고 모든 3D 메쉬 컴포넌트를 파싱하여 반환합니다.
 * 이미 로드된 적이 있는 폴더는 메모리 캐시에서 즉시 반환하여 2회차 로딩을 0초로 단축합니다.
 * @param {object} options
 * @param {string} options.folder - 대상 모드 폴더 경로
 * @param {object} options.context - PluginContext
 * @param {any} options.viewer - ModViewer3D 인스턴스 (WebGL 렌더러 참조용)
 * @param {(status: string) => void} [options.onProgress] - 진행 상태 알림 콜백
 * @param {boolean} [options.forceReload=false] - 캐시를 무시하고 디스크에서 강제 재로드 여부
 * @returns {Promise<{ iniFiles: any[], parsedIniEntries: any[], totalMeshComponents: number }>}
 */
export async function loadModData({ folder, context, viewer, onProgress, forceReload = false }) {
  const currentFolder = folder.replace(/\\/g, '/');

  // 1. 동일 JS 런타임 메모리 캐시가 유효하면 즉각 반환 (0초 반환)
  if (!forceReload && modDataCache.has(currentFolder)) {
    context.logger?.info(`[3D 뷰어] 자체 메모리 캐시된 모드 데이터 재사용 (${currentFolder})`);
    onProgress?.(`캐시된 모드 데이터를 불러왔습니다.`);
    return modDataCache.get(currentFolder);
  }

  // 2. 다른 창(메인 창 <-> 별도 OS 창)에 이미 로딩된 3D 데이터가 있는지 확인 (중복 디스크 I/O 제거)
  if (!forceReload) {
    onProgress?.(`이전 창에서 로드된 모드 데이터 확인 중…`);
    const remoteCache = await requestCacheFromOtherWindow(currentFolder, viewer, context);
    if (remoteCache) {
      context.logger?.info(`[3D 뷰어] 다른 창으로부터 3D 모드 캐시 핸드오프 성공! 디스크 재로딩 생략 (${currentFolder})`);
      onProgress?.(`모드 데이터를 즉시 복원했습니다.`);
      modDataCache.set(currentFolder, remoteCache);
      return remoteCache;
    }
  }

  onProgress?.(`모드 폴더 스캔 중… (${currentFolder})`);

  let scanResult = await scanModDirectory(context.workspace, currentFolder, context.logger);
  let iniFiles = scanResult.iniFiles;
  let allFiles = scanResult.allFiles;

  if (iniFiles.length === 0) {
    return { iniFiles: [], parsedIniEntries: [], totalMeshComponents: 0 };
  }

  context.logger?.info(`[3D 뷰어] 모드 폴더 내 ${iniFiles.length}개 INI 파일 발견:`, iniFiles.map((i) => i.name));

  // 파일 경로 해석 헬퍼 (INI 서브폴더 우선 -> 모드 루트 -> allFiles 매핑)
  function resolveFilePath(iniDir, fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    const fn = fileName.trim().replace(/\\/g, '/');
    const subPath = `${iniDir}/${fn}`;
    if (allFiles.has(subPath.toLowerCase())) return allFiles.get(subPath.toLowerCase());
    const rootPath = `${currentFolder}/${fn}`;
    if (allFiles.has(rootPath.toLowerCase())) return allFiles.get(rootPath.toLowerCase());
    const baseName = fn ? fn.split('/').pop().toLowerCase() : '';
    if (baseName && allFiles.has(baseName)) return allFiles.get(baseName);
    return subPath;
  }

  // 코어 슬롯 매칭 엔진의 슬롯 및 감지된 텍스처 파일 조회
  const coreSlots = context.slots?.getSlots?.() || [];
  const detectedTextureFiles = context.slots?.getDetectedTextureFiles?.() || [];
  const allTextureSet = new Set(detectedTextureFiles);
  for (const filePath of allFiles.values()) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.dds') || lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      const fn = filePath.split('/').pop();
      if (fn) allTextureSet.add(fn);
    }
  }
  const allDetectedTextures = Array.from(allTextureSet).sort();

  const parsedIniEntries = [];

  for (let idx = 0; idx < iniFiles.length; idx++) {
    const ini = iniFiles[idx];
    onProgress?.(`[${idx + 1}/${iniFiles.length}] ${ini.name} 파싱 중…`);

    let iniContent = '';
    try {
      iniContent = await context.workspace.readTextFile(ini.path);
    } catch (e) {
      context.logger?.warn(`INI 파일 읽기 실패 (${ini.path}):`, e);
      continue;
    }

    if (!iniContent || typeof iniContent !== 'string') {
      context.logger?.warn(`INI 파일 내용이 비어있거나 올바르지 않습니다 (${ini.path})`);
      continue;
    }

    const parsed = parseModIni(iniContent);
    const resMap = parsed.resources || {};
    const overrides = parsed.overrides || [];

    const iniComponents = [];
    const iniParts = [];
    let iniVertexCount = 0;

    if (overrides.length > 0) {
      for (const ov of overrides) {
        let posRes = null;
        let tcRes = null;
        let ibRes = null;
        let diffRes = null;
        let normRes = null;

        // 0. 코어 슬롯 매칭 엔진에서 지정된 텍스처 슬롯 우선 반영
        const matchedSlot = coreSlots.find((s) => s.sectionName && s.sectionName.toLowerCase() === ov.section.toLowerCase());
        if (matchedSlot && Array.isArray(matchedSlot.textureSlots)) {
          const diffSlot = matchedSlot.textureSlots.find((t) => t.slotType === 'diffuse' || (t.slotId && t.slotId.toLowerCase().includes('diffuse')) || t.slotId === 'ps-t0');
          if (diffSlot && diffSlot.textureFile) {
            diffRes = { filename: diffSlot.textureFile, name: diffSlot.resourceRef || 'CoreSlotDiffuse' };
          } else if (diffSlot && diffSlot.resourceRef && resMap[diffSlot.resourceRef]) {
            diffRes = resMap[diffSlot.resourceRef];
          }
          const normSlot = matchedSlot.textureSlots.find((t) => t.slotType === 'normal' || (t.slotId && t.slotId.toLowerCase().includes('normal')) || t.slotId === 'ps-t1');
          if (normSlot && normSlot.textureFile) {
            normRes = { filename: normSlot.textureFile, name: normSlot.resourceRef || 'CoreSlotNormal' };
          } else if (normSlot && normSlot.resourceRef && resMap[normSlot.resourceRef]) {
            normRes = resMap[normSlot.resourceRef];
          }
        }

        // 1. 명시적 프로퍼티(vb0, ib, vb1, ps-t0, ps-t1 등) 우선 조회
        if (ov.refs) {
          if (ov.refs.vb0 && resMap[ov.refs.vb0]) posRes = resMap[ov.refs.vb0];
          if (ov.refs.ib && resMap[ov.refs.ib]) ibRes = resMap[ov.refs.ib];
          if (ov.refs.vb1 && resMap[ov.refs.vb1]) tcRes = resMap[ov.refs.vb1];
          if (!diffRes && ov.refs['ps-t0'] && resMap[ov.refs['ps-t0']]) diffRes = resMap[ov.refs['ps-t0']];
          if (!normRes && ov.refs['ps-t1'] && resMap[ov.refs['ps-t1']]) normRes = resMap[ov.refs['ps-t1']];
        }

        // 2. 섹션 이름 핵심 키워드 및 공통 캐릭터 접두사 매칭
        const secBase = ov.section.replace(/^TextureOverride/i, '').toLowerCase();
        const commonPrefix = secBase.replace(/[a-z0-9]$/i, '');

        for (const rKey of Object.keys(resMap)) {
          const r = resMap[rKey];
          const lowerKey = rKey.toLowerCase();
          const lowerFile = (r.filename || '').toLowerCase();
          const isDirectMatch = lowerKey.includes(secBase) || secBase.includes(lowerKey.replace(/^resource/i, ''));
          const isPrefixMatch = commonPrefix.length >= 4 && (lowerKey.includes(commonPrefix) || lowerFile.includes(commonPrefix));

          if (!posRes && (isDirectMatch || isPrefixMatch) && (lowerKey.includes('position') || lowerFile.includes('position'))) {
            posRes = r;
          }
          if (!tcRes && (isDirectMatch || isPrefixMatch) && (lowerKey.includes('texcoord') || lowerFile.includes('texcoord'))) {
            tcRes = r;
          }
          if (!ibRes && (isDirectMatch || isPrefixMatch) && (lowerKey.includes('ib') || lowerFile.endsWith('.ib'))) {
            ibRes = r;
          }
          if (!diffRes && (isDirectMatch || isPrefixMatch) && (lowerKey.includes('diffuse') || lowerFile.includes('diffuse'))) {
            diffRes = r;
          }
          if (!normRes && (isDirectMatch || isPrefixMatch) && (lowerKey.includes('normal') || lowerFile.includes('normal'))) {
            normRes = r;
          }
        }

        // 3. INI 파일 전체 공유 리소스 폴백
        if (!posRes) {
          posRes = Object.values(resMap).find((r) => (r.name || '').toLowerCase().includes('position') || (r.filename || '').toLowerCase().includes('position'));
        }
        if (!tcRes) {
          tcRes = Object.values(resMap).find((r) => (r.name || '').toLowerCase().includes('texcoord') || (r.filename || '').toLowerCase().includes('texcoord'));
        }
        if (!ibRes) {
          ibRes = Object.values(resMap).find((r) => (r.name || '').toLowerCase().endsWith('ib') || (r.filename || '').toLowerCase().endsWith('.ib'));
        }

        // 4. 폴백: INI 디렉터리 내 실제 파일(allFiles)에서 검색
        if (!posRes) {
          const p = Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().includes(secBase) && f.toLowerCase().includes('position')) ||
                    Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().includes('position')) ||
                    Array.from(allFiles.values()).find((f) => f.toLowerCase().includes('position'));
          if (p) posRes = { filename: p.split('/').pop(), stride: 40 };
        }
        if (!tcRes) {
          const p = Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().includes(secBase) && f.toLowerCase().includes('texcoord')) ||
                    Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().includes('texcoord')) ||
                    Array.from(allFiles.values()).find((f) => f.toLowerCase().includes('texcoord'));
          if (p) tcRes = { filename: p.split('/').pop(), stride: 20 };
        }
        if (!ibRes) {
          const p = Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().includes(secBase) && f.toLowerCase().endsWith('.ib')) ||
                    Array.from(allFiles.values()).find((f) => f.startsWith(ini.dir) && f.toLowerCase().endsWith('.ib'));
          if (p) ibRes = { filename: p.split('/').pop(), format: 'DXGI_FORMAT_R32_UINT' };
        }

        if (!posRes || !ibRes) {
          context.logger?.debug(`[${ini.name}] ${ov.section}에 해당하는 Position 또는 IB 버퍼가 없어 건너뜁니다.`);
          continue;
        }

        const posPath = resolveFilePath(ini.dir, posRes.filename);
        const ibPath = resolveFilePath(ini.dir, ibRes.filename);

        try {
          onProgress?.(`[${ini.name}] 3D 버퍼 로딩 중…`);
          const [posBytes, ibBytes] = await Promise.all([
            context.workspace.readBinaryFile(posPath),
            context.workspace.readBinaryFile(ibPath),
          ]);

          const stride = parseInt(posRes.stride, 10) || 40;
          const { positions, vertexCount } = parsePositionBuffer(posBytes, stride);
          const indices = parseIndexBuffer(ibBytes, ibRes.format || 'DXGI_FORMAT_R32_UINT');

          iniVertexCount += vertexCount;

          // Texcoord 로드
          let uvs = null;
          if (tcRes && tcRes.filename) {
            try {
              const tcPath = resolveFilePath(ini.dir, tcRes.filename);
              const tcBytes = await context.workspace.readBinaryFile(tcPath);
              const tcStride = parseInt(tcRes.stride, 10) || 20;
              uvs = parseTexcoordBuffer(tcBytes, tcStride, vertexCount);
            } catch (tcErr) {
              context.logger?.warn(`[${ini.name}] Texcoord 로드 경고:`, tcErr);
            }
          }

          // 텍스처 로드 (오류 발생 시에도 메쉬 표시는 절대 중단되지 않음)
          let diffuseTexture = null;
          let normalTexture = null;
          let diffuseBytes = null;
          let normalBytes = null;
          let diffuseIsDds = false;

          if (diffRes && diffRes.filename) {
            try {
              const dPath = resolveFilePath(ini.dir, diffRes.filename);
              diffuseBytes = await context.workspace.readBinaryFile(dPath);
              if (diffRes.filename.toLowerCase().endsWith('.dds')) {
                diffuseIsDds = true;
                diffuseTexture = parseDdsTexture(diffuseBytes, context, viewer?.renderer, { isDiffuse: true, isNormal: false });
              } else {
                const mime = diffRes.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
                diffuseTexture = await loadImageTexture(diffuseBytes, mime, true);
              }
            } catch (dErr) {
              context.logger?.warn(`[${ini.name}] Diffuse 로드 경고:`, dErr);
            }
          }

          if (normRes && normRes.filename) {
            try {
              const nPath = resolveFilePath(ini.dir, normRes.filename);
              normalBytes = await context.workspace.readBinaryFile(nPath);
              if (normRes.filename.toLowerCase().endsWith('.dds')) {
                normalTexture = parseDdsTexture(normalBytes, context, viewer?.renderer, { isDiffuse: false, isNormal: true });
              } else {
                const mime = normRes.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
                normalTexture = await loadImageTexture(normalBytes, mime, false, { isNormal: true });
              }
            } catch (nErr) {
              context.logger?.warn(`[${ini.name}] Normal 로드 경고:`, nErr);
            }
          }

          iniComponents.push({
            name: ov.section,
            iniName: ini.name,
            positions,
            uvs,
            indices,
            parts: ov.parts,
            diffuseTexture,
            normalTexture,
            diffuseBytes,
            normalBytes,
            diffuseIsDds,
          });

          for (const pt of ov.parts) {
            iniParts.push({
              ...pt,
              id: pt.id || `${ov.section}_${pt.name}`,
              sectionName: ov.section,
              textureFile: diffRes?.filename || null,
              slot: matchedSlot ? { part: matchedSlot.part, partName: matchedSlot.partName } : null,
              name: `[${ini.name.replace(/\.ini$/i, '')}] ${pt.name}`,
            });
          }
        } catch (bufErr) {
          context.logger?.warn(`[${ini.name}] 버퍼 파일 로드 실패 (${posPath}):`, bufErr);
        }
      }
    }

    const relativeName = ini.path.startsWith(currentFolder + '/')
      ? ini.path.slice(currentFolder.length + 1)
      : ini.name;

    parsedIniEntries.push({
      path: ini.path,
      name: ini.name,
      relativeName,
      enabled: true,
      constants: parsed.constants || {},
      keyBindings: parsed.keyBindings || {},
      components: iniComponents,
      parts: iniParts,
      vertexCount: iniVertexCount,
    });
  }

  const totalMeshComponents = parsedIniEntries.reduce((sum, e) => sum + e.components.length, 0);
  const result = { iniFiles, parsedIniEntries, totalMeshComponents, detectedTextures: allDetectedTextures };
  if (totalMeshComponents > 0) {
    modDataCache.set(currentFolder, result);
  }
  return result;
}
