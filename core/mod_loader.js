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

  // 고속 인메모리 로딩 캐시 (동일 버퍼/텍스처 파일의 중복 디스크 I/O 및 중복 디코딩 원천 제거)
  const fileBytesCache = new Map();
  const parsedBufferCache = new Map();
  const textureCache = new Map();

  async function getFileBytes(filePath) {
    if (!filePath) return null;
    const norm = filePath.replace(/\\/g, '/');
    if (fileBytesCache.has(norm)) {
      return fileBytesCache.get(norm);
    }
    try {
      const bytes = await context.workspace.readBinaryFile(norm);
      fileBytesCache.set(norm, bytes);
      return bytes;
    } catch (e) {
      return null;
    }
  }

  async function getOrLoadTexture(texPath, isNormal) {
    if (!texPath) return null;
    const norm = texPath.replace(/\\/g, '/');
    const cacheKey = `${norm}_${isNormal ? 'norm' : 'diff'}`;
    if (textureCache.has(cacheKey)) {
      return textureCache.get(cacheKey);
    }
    const bytes = await getFileBytes(norm);
    if (!bytes) return null;
    let tex = null;
    try {
      if (norm.toLowerCase().endsWith('.dds')) {
        tex = parseDdsTexture(bytes, context, viewer?.renderer, { isDiffuse: !isNormal, isNormal });
      } else {
        const mime = norm.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        tex = await loadImageTexture(bytes, mime, !isNormal, { isNormal });
      }
      if (tex) textureCache.set(cacheKey, tex);
    } catch (e) {
      context.logger?.warn(`[3D 뷰어] 텍스처 로드 실패 (${norm}):`, e);
    }
    return tex;
  }

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

        // 1. 명시적 프로퍼티(vb0, ib, vb1, diffuse, normal, ps-t0, ps-t1 등) 우선 조회 (대소문자 무시)
        const findExplicitRes = (refName) => {
          if (!refName) return null;
          if (resMap[refName]) return resMap[refName];
          const lower = refName.toLowerCase();
          for (const k of Object.keys(resMap)) {
            if (k.toLowerCase() === lower) return resMap[k];
          }
          return null;
        };

        if (ov.refs) {
          if (ov.refs.vb0) posRes = findExplicitRes(ov.refs.vb0);
          if (ov.refs.ib) ibRes = findExplicitRes(ov.refs.ib);
          if (ov.refs.vb1) tcRes = findExplicitRes(ov.refs.vb1);
          if (!diffRes && ov.refs.diffuse) diffRes = findExplicitRes(ov.refs.diffuse);
          if (!diffRes && ov.refs['ps-t0']) diffRes = findExplicitRes(ov.refs['ps-t0']);
          if (!normRes && ov.refs.normal) normRes = findExplicitRes(ov.refs.normal);
          if (!normRes && ov.refs['ps-t1']) normRes = findExplicitRes(ov.refs['ps-t1']);
        }

        // 2. 범용 유사도 스코어링 매칭 (컴포넌트 어근 stem + 해시 + 토큰 기반)
        const cleanOv = ov.section.replace(/^TextureOverride_?/i, '').toLowerCase();
        // 서브파츠 단일 접미사(예: a, b 등) 제거한 어근(stem, 예: roxywpw1a -> roxywpw1, roxybodya -> roxybody)
        const stem = cleanOv.replace(/[a-z]$/i, '');
        // 8자리 16진수 해시 추출
        const hexHashMatch = cleanOv.match(/[0-9a-f]{8}/i);
        const ovHash = hexHashMatch ? hexHashMatch[0].toLowerCase() : null;
        // 유의미한 토큰 분리
        const tokens = cleanOv.split(/[_ \-\/\.]+/).filter((t) => t.length >= 2 && !['ib', 'vb', 'component', 'part'].includes(t));

        const scoreResource = (r, typeKeywords) => {
          const rName = (r.name || '').toLowerCase();
          const rFile = (r.filename || '').toLowerCase();
          const combined = `${rName} ${rFile}`;

          // 해당 타입 키워드가 없으면 후보 제외
          const hasType = typeKeywords.some((kw) => combined.includes(kw));
          if (!hasType) return -1;

          let score = 10;

          // 8자리 16진수 해시 일치 (최우선)
          if (ovHash && combined.includes(ovHash)) {
            score += 200;
          }

          // 기본 어근(stem, 예: roxywpw1, roxywpw2, roxywpwrope, roxybody) 일치
          if (stem.length >= 3 && combined.includes(stem)) {
            score += 150;
          }

          // 전체 섹션 기본명(cleanOv) 일치
          if (cleanOv.length >= 3 && combined.includes(cleanOv)) {
            score += 100;
          }

          // 토큰 일치
          for (const tok of tokens) {
            if (tok.length >= 3 && combined.includes(tok)) {
              score += 50;
            }
          }

          return score;
        };

        const findBestResource = (typeKeywords) => {
          let best = null;
          let highestScore = 0;
          for (const rKey of Object.keys(resMap)) {
            const r = resMap[rKey];
            const sc = scoreResource(r, typeKeywords);
            if (sc > highestScore) {
              highestScore = sc;
              best = r;
            }
          }
          return best;
        };

        if (!posRes) posRes = findBestResource(['position']);
        if (!tcRes) tcRes = findBestResource(['texcoord']);
        if (!ibRes) ibRes = findBestResource(['component', 'ib']);
        if (!diffRes) diffRes = findBestResource(['diffuse']);
        if (!normRes) normRes = findBestResource(['normal']);

        // 3. 폴백: INI 디렉터리 내 실제 파일(allFiles)에서 최고 적합 파일 검색
        const findBestFile = (typeKeywords, defaultStride = 0) => {
          let bestFile = null;
          let highestScore = 0;
          for (const f of allFiles.values()) {
            if (!f.startsWith(ini.dir)) continue;
            const sc = scoreResource({ name: f, filename: f }, typeKeywords);
            if (sc > highestScore) {
              highestScore = sc;
              bestFile = f;
            }
          }
          if (bestFile) {
            return { filename: bestFile.split('/').pop(), stride: defaultStride };
          }
          return null;
        };

        if (!posRes) posRes = findBestFile(['position'], 40);
        if (!tcRes) tcRes = findBestFile(['texcoord'], 20);
        if (!ibRes) {
          const bf = findBestFile(['ib', 'component']);
          if (bf) ibRes = { filename: bf.filename, format: 'DXGI_FORMAT_R32_UINT' };
        }


        if (!posRes || !ibRes) {
          context.logger?.debug(`[${ini.name}] ${ov.section}에 해당하는 Position 또는 IB 버퍼가 없어 건너뜁니다.`);
          continue;
        }

        const posPath = resolveFilePath(ini.dir, posRes.filename);
        const ibPath = resolveFilePath(ini.dir, ibRes.filename);
        const tcPath = tcRes && tcRes.filename ? resolveFilePath(ini.dir, tcRes.filename) : null;
        const diffPath = diffRes && diffRes.filename ? resolveFilePath(ini.dir, diffRes.filename) : null;
        const normPath = normRes && normRes.filename ? resolveFilePath(ini.dir, normRes.filename) : null;

        try {
          onProgress?.(`[${ini.name}] 3D 버퍼 및 텍스처 로딩 중…`);

          // 필요한 파일 바이너리들을 캐시 기반으로 동시 병렬 로드 (중복 디스크 I/O 제거)
          const [posBytes, ibBytes, tcBytes] = await Promise.all([
            getFileBytes(posPath),
            getFileBytes(ibPath),
            tcPath ? getFileBytes(tcPath) : Promise.resolve(null),
          ]);

          if (!posBytes || !ibBytes) {
            context.logger?.warn(`[${ini.name}] 필수 버퍼 파일 누락: ${posPath} 또는 ${ibPath}`);
            continue;
          }

          const stride = parseInt(posRes.stride, 10) || 40;
          const posCacheKey = `${posPath}_${stride}`;
          let posData = parsedBufferCache.get(posCacheKey);
          if (!posData) {
            posData = parsePositionBuffer(posBytes, stride);
            parsedBufferCache.set(posCacheKey, posData);
          }
          const { positions, vertexCount } = posData;

          const ibFormat = ibRes.format || 'DXGI_FORMAT_R32_UINT';
          const ibCacheKey = `${ibPath}_${ibFormat}`;
          let indices = parsedBufferCache.get(ibCacheKey);
          if (!indices) {
            indices = parseIndexBuffer(ibBytes, ibFormat);
            parsedBufferCache.set(ibCacheKey, indices);
          }

          iniVertexCount += vertexCount;

          // Texcoord 파싱 (캐시 재사용)
          let uvs = null;
          if (tcBytes) {
            const tcStride = parseInt(tcRes.stride, 10) || 20;
            const tcCacheKey = `${tcPath}_${tcStride}_${vertexCount}`;
            uvs = parsedBufferCache.get(tcCacheKey);
            if (!uvs) {
              uvs = parseTexcoordBuffer(tcBytes, tcStride, vertexCount);
              parsedBufferCache.set(tcCacheKey, uvs);
            }
          }

          // 텍스처 로드 (중복 디코딩 제거 및 병렬 처리)
          const [diffuseTexture, normalTexture] = await Promise.all([
            diffPath ? getOrLoadTexture(diffPath, false) : Promise.resolve(null),
            normPath ? getOrLoadTexture(normPath, true) : Promise.resolve(null),
          ]);

          const diffuseBytes = diffPath ? fileBytesCache.get(diffPath.replace(/\\/g, '/')) || null : null;
          const normalBytes = normPath ? fileBytesCache.get(normPath.replace(/\\/g, '/')) || null : null;
          const diffuseIsDds = diffPath ? diffPath.toLowerCase().endsWith('.dds') : false;

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
            pt.iniName = ini.name;
            iniParts.push({
              ...pt,
              id: pt.id || `${ov.section}_${pt.name}`,
              sectionName: ov.section,
              iniName: ini.name,
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
