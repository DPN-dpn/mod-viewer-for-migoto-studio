/**
 * core/scanner.js
 * 모드 디렉터리 내의 모든 파일 및 .ini 파일들을 고속/재귀적으로 수집하고,
 * 에디터 워크스페이스의 현재 활성 모드 폴더를 탐지합니다.
 */

/**
 * 모드 폴더 내의 모든 파일과 .ini 파일들을 완벽하게 수집
 * Migoto Studio의 신규 workspace.findFiles 고속 API를 최우선 사용하고, 구버전은 readDirectory 트리 재귀로 폴백합니다.
 * @param {object} workspace - PluginContext.workspace
 * @param {string} rootFolder - 대상 루트 폴더 경로
 * @param {object} [logger] - PluginContext.logger
 * @returns {Promise<{ iniFiles: Array<{ name: string, path: string, dir: string }>, allFiles: Map<string, string> }>}
 */
export async function scanModDirectory(workspace, rootFolder, logger) {
  const iniFiles = [];
  const allFiles = new Map(); // lowercase filename -> full path
  const cleanRoot = rootFolder.replace(/\\/g, '/').replace(/\/+$/, '');

  logger?.info(`[3D 뷰어] 모드 디렉터리 스캔 시작: ${cleanRoot}`);

  // 1. 신규 고속 findFiles API 우선 시도 (초고속 glob 검색)
  if (typeof workspace?.findFiles === 'function') {
    try {
      const [foundIniPaths, foundAllPaths] = await Promise.all([
        workspace.findFiles('**/*.ini', { cwd: cleanRoot }),
        workspace.findFiles('**/*', { cwd: cleanRoot }),
      ]);

      if (Array.isArray(foundAllPaths)) {
        for (const p of foundAllPaths) {
          const rawPath = typeof p === 'string' ? p : (p?.path || '');
          if (!rawPath) continue;
          const normP = rawPath.replace(/\\/g, '/');
          const fn = normP.split('/').pop();
          if (fn) {
            allFiles.set(fn.toLowerCase(), normP);
            allFiles.set(normP.toLowerCase(), normP);
          }
        }
      }

      if (Array.isArray(foundIniPaths) && foundIniPaths.length > 0) {
        for (const p of foundIniPaths) {
          const rawPath = typeof p === 'string' ? p : (p?.path || '');
          if (!rawPath) continue;
          const normP = rawPath.replace(/\\/g, '/');
          const fn = normP.split('/').pop();
          const dir = normP.substring(0, normP.lastIndexOf('/'));
          if (fn) {
            iniFiles.push({
              name: fn,
              path: normP,
              dir,
            });
          }
        }
        logger?.info(`[3D 뷰어] findFiles로 초고속 스캔 완료: 총 ${iniFiles.length}개 INI 발견 (${iniFiles.map((i) => i.name).join(', ')})`);
        return { iniFiles, allFiles };
      }
    } catch (e) {
      logger?.debug?.('[3D 뷰어] findFiles 실행 중 폴백으로 전환:', e);
    }
  }

  // 2. 폴백: desktop.ts readDirectory 트리 순회 (children & isDir 지원)
  function processEntries(entries, currentDir) {
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const entryName = entry.name || (typeof entry === 'string' ? entry : '');
      if (!entryName) continue;
      if (entryName === '.git' || entryName === 'node_modules') continue;

      const fullPath = (entry.path || `${currentDir}/${entryName}`).replace(/\\/g, '/');
      const isDirectory = Boolean(
        entry.isDir === true ||
        entry.isDirectory === true ||
        entry.type === 'directory' ||
        (Array.isArray(entry.children) && entry.children.length > 0)
      );

      if (isDirectory) {
        if (Array.isArray(entry.children) && entry.children.length > 0) {
          processEntries(entry.children, fullPath);
        }
      } else {
        allFiles.set(entryName.toLowerCase(), fullPath);
        allFiles.set(fullPath.toLowerCase(), fullPath);

        if (entryName.toLowerCase().endsWith('.ini')) {
          logger?.info(`[3D 뷰어] INI 발견: ${entryName} (${fullPath})`);
          iniFiles.push({
            name: entryName,
            path: fullPath,
            dir: currentDir.replace(/\\/g, '/'),
          });
        }
      }
    }
  }

  let rootEntries = [];
  try {
    rootEntries = await workspace.readDirectory(cleanRoot);
    if (!Array.isArray(rootEntries) || rootEntries.length === 0) {
      rootEntries = await workspace.readDirectory(cleanRoot.replace(/\//g, '\\'));
    }
  } catch (err) {
    logger?.warn?.(`[3D 뷰어] readDirectory 실패 (${cleanRoot}):`, err);
  }

  processEntries(rootEntries, cleanRoot);

  // 3. 만약 children이 없어 하위 폴더 탐색이 필요할 때를 위한 2차 수동 폴백 순회
  async function traverseFallback(dir, depth = 0) {
    if (depth > 5) return;
    try {
      let subEntries = await workspace.readDirectory(dir);
      if (!Array.isArray(subEntries) || subEntries.length === 0) {
        subEntries = await workspace.readDirectory(dir.replace(/\//g, '\\'));
      }
      if (!Array.isArray(subEntries)) return;

      for (const entry of subEntries) {
        const entryName = entry.name || '';
        if (!entryName || entryName === '.git' || entryName === 'node_modules') continue;

        const fullPath = (entry.path || `${dir}/${entryName}`).replace(/\\/g, '/');
        const isDirectory = Boolean(
          entry.isDir === true ||
          entry.isDirectory === true ||
          !entryName.includes('.')
        );

        if (isDirectory) {
          await traverseFallback(fullPath, depth + 1);
        } else {
          allFiles.set(entryName.toLowerCase(), fullPath);
          allFiles.set(fullPath.toLowerCase(), fullPath);

          if (entryName.toLowerCase().endsWith('.ini')) {
            if (!iniFiles.some((f) => f.path.toLowerCase() === fullPath.toLowerCase())) {
              logger?.info(`[3D 뷰어] 폴백 재귀로 INI 발견: ${entryName} (${fullPath})`);
              iniFiles.push({
                name: entryName,
                path: fullPath,
                dir: dir.replace(/\\/g, '/'),
              });
            }
          }
        }
      }
    } catch (e) {
      logger?.debug?.(`[3D 뷰어] 폴백 순회 스킵 (${dir})`);
    }
  }

  if (iniFiles.length === 0) {
    logger?.info(`[3D 뷰어] 1차 트리에서 INI를 찾지 못해 하위 디렉터리 폴백 재귀 스캔을 실행합니다.`);
    await traverseFallback(cleanRoot, 0);
  }

  logger?.info(`[3D 뷰어] 디렉터리 스캔 완료: 총 ${iniFiles.length}개 INI 파일 발견 (${iniFiles.map((i) => i.name).join(', ')})`);
  return { iniFiles, allFiles };
}

/**
 * 워크스페이스의 현재 활성 모드 폴더 경로 가져오기
 * (순수하게 에디터 파일 탐색기에 열려있는 모드 루트 폴더만 추적합니다. ini 탭 파일은 추적하지 않습니다.)
 * @param {object} context - PluginContext
 * @returns {string | null}
 */
export function getActiveModFolder(context) {
  let folder = context.workspace?.getCurrentFolder?.() || context.workspace?.getActiveFolder?.();
  if (folder && typeof folder === 'string' && folder.trim()) {
    return folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }
  return null;
}
