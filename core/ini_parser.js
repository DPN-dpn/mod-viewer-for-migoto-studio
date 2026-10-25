/**
 * core/ini_parser.js
 * 3DMigoto/XXMI INI 파일(예: Roxy.ini)을 파싱하여
 * Constants(토글 변수), TextureOverride(서브메쉬 및 조건식), Resource(버퍼 및 텍스처) 정보를 추출합니다.
 */

export function parseModIni(iniContent) {
  if (!iniContent || typeof iniContent !== 'string') {
    return { constants: {}, keyBindings: {}, resources: {}, overrides: [] };
  }
  const lines = iniContent.split(/\r?\n/);

  const constants = {}; // { $varName: defaultValue }
  const keyBindings = {}; // { $varName: [states...] }
  const resources = {}; // { name: { type, stride, filename, format } }
  const overrides = []; // [ { section, parts: [ { name, condition, count, firstIndex, offset } ] } ]

  let currentComment = '';

  // 1차 패스: 섹션 분리
  const sections = [];
  let curSec = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      currentComment = '';
      continue;
    }

    if (trimmed.startsWith(';')) {
      // 주석 기록 (파츠 이름 파악용)
      currentComment = trimmed.replace(/^;\s*/, '');
      continue;
    }

    const secMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (secMatch) {
      curSec = {
        name: secMatch[1],
        lines: [],
      };
      sections.push(curSec);
      currentComment = '';
      continue;
    }

    if (curSec) {
      curSec.lines.push({
        raw: rawLine,
        text: trimmed,
        comment: currentComment,
      });
      currentComment = '';
    }
  }

  // 2차 패스: 각 섹션별 분석
  for (const sec of sections) {
    const secLower = sec.name.toLowerCase();

    // 1. [Constants] 섹션
    if (secLower === 'constants') {
      for (const lineObj of sec.lines) {
        const m = lineObj.text.match(/(?:global\s+)?(?:persist\s+)?(\$[\w_]+)\s*=\s*([^\s;]+)/i);
        if (m) {
          const varName = m[1].toLowerCase();
          const val = parseFloat(m[2]) || 0;
          constants[varName] = val;
        }
      }
    }

    // 2. [Key...] 섹션 (토글 변수 상태 리스트)
    if (secLower.startsWith('key')) {
      for (const lineObj of sec.lines) {
        const m = lineObj.text.match(/^(\$[\w_]+)\s*=\s*(.+)$/i);
        if (m) {
          const varName = m[1].toLowerCase();
          const states = m[2].split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
          keyBindings[varName] = states;
          if (constants[varName] === undefined && states.length > 0) {
            constants[varName] = states[0];
          }
        }
      }
    }

    // 3. [Resource...] 섹션 (버퍼/텍스처)
    if (secLower.startsWith('resource')) {
      const resData = { name: sec.name };
      for (const lineObj of sec.lines) {
        const [k, ...v] = lineObj.text.split('=');
        if (k && v.length) {
          const key = k.trim().toLowerCase();
          const val = v.join('=').trim();
          resData[key] = val;
        }
      }
      resources[sec.name] = resData;
    }

    // 4. [TextureOverride...] 섹션 (서브메쉬 & drawindexed)
    if (secLower.startsWith('textureoverride')) {
      const overrideObj = {
        section: sec.name,
        hash: null,
        matchFirstIndex: 0,
        matchIndexCount: 0,
        refs: {}, // ib, vb0, vb1, vb2, ps-t0 등 참조 리소스 이름
        parts: [],
      };

      // 섹션 이름에서 8자리 16진수 해시 자동 추출
      const secHashMatch = sec.name.match(/(?:^|[_ \-\/\.])([0-9a-fA-F]{8})(?:[_ \-\/\.]|$)/);
      if (secHashMatch) {
        overrideObj.hash = secHashMatch[1].toLowerCase();
      }

      let activeIfCondition = null;
      let partComment = '';
      let pendingDrawCount = null;
      let pendingDrawFirstIndex = 0;
      let pendingDrawOffset = 0;

      for (let i = 0; i < sec.lines.length; i++) {
        const lineObj = sec.lines[i];
        const txt = lineObj.text;

        if (lineObj.comment) {
          partComment = lineObj.comment;
        }

        // hash = xxxxxxxx 프로퍼티 추출
        const hashMatch = txt.match(/^hash\s*=\s*([0-9a-fA-F]{8})/i);
        if (hashMatch) {
          overrideObj.hash = hashMatch[1].toLowerCase();
        }

        // 키=값 프로퍼티 추출 (ib, vb0, vb1, vb2, ps-t0, Resource\ZZMI\Diffuse 등)
        const eqMatch = txt.match(/^([a-zA-Z0-9_\-\\\/\.]+)\s*=\s*(?:ref\s+)?(.+)$/i);
        if (eqMatch) {
          const rawKey = eqMatch[1].trim().toLowerCase();
          const propVal = eqMatch[2].trim();
          overrideObj.refs[rawKey] = propVal;

          // ZZMI/호요버스 스타일 키 정규화
          if (rawKey.includes('diffuse')) {
            overrideObj.refs['diffuse'] = propVal;
          } else if (rawKey.includes('normal')) {
            overrideObj.refs['normal'] = propVal;
          } else if (rawKey.includes('lightmap')) {
            overrideObj.refs['lightmap'] = propVal;
          } else if (rawKey.includes('materialmap')) {
            overrideObj.refs['materialmap'] = propVal;
          }
        }

        // match_first_index / match_index_count
        const mFirst = txt.match(/^match_first_index\s*=\s*(\d+)/i);
        if (mFirst) overrideObj.matchFirstIndex = parseInt(mFirst[1], 10);

        const mCount = txt.match(/^match_index_count\s*=\s*(\d+)/i);
        if (mCount) overrideObj.matchIndexCount = parseInt(mCount[1], 10);

        // CommandList 드로우 매개변수 패턴: $\TTL\_1, $_1 = count
        const cmdCountMatch = txt.match(/^\$([^\s=]*_1)\s*=\s*(\d+)/i);
        if (cmdCountMatch) {
          pendingDrawCount = parseInt(cmdCountMatch[2], 10);
        }

        // $\TTL\_2, $_2 = firstIndex
        const cmdFirstMatch = txt.match(/^\$([^\s=]*_2)\s*=\s*(\d+)/i);
        if (cmdFirstMatch) {
          pendingDrawFirstIndex = parseInt(cmdFirstMatch[2], 10);
        }

        // $\TTL\_3, $_3 = vertexOffset
        const cmdOffsetMatch = txt.match(/^\$([^\s=]*_3)\s*=\s*(\d+)/i);
        if (cmdOffsetMatch) {
          pendingDrawOffset = parseInt(cmdOffsetMatch[2], 10);
        }

        // run = CommandList\...\Draw 발동 시 (drawindexed = count, first_index, offset과 동일)
        const runDrawMatch = txt.match(/^run\s*=\s*CommandList[^\s]*\\Draw/i) || txt.match(/^run\s*=\s*.*Draw\b/i);
        if (runDrawMatch && pendingDrawCount !== null && pendingDrawCount > 0) {
          let name = partComment || `Part_${overrideObj.parts.length + 1}`;
          name = name.replace(/\s*\(\d+\)$/, '').trim();

          overrideObj.parts.push({
            id: `${sec.name}_p${overrideObj.parts.length + 1}`,
            sectionName: sec.name,
            name,
            condition: activeIfCondition,
            count: pendingDrawCount,
            firstIndex: pendingDrawFirstIndex,
            vertexOffset: pendingDrawOffset,
          });

          partComment = '';
          pendingDrawCount = null;
          pendingDrawFirstIndex = 0;
          pendingDrawOffset = 0;
          continue;
        }

        // if 조건문 시작
        const ifMatch = txt.match(/^if\s+(.+)$/i);
        if (ifMatch) {
          activeIfCondition = ifMatch[1].trim();
          continue;
        }

        // elif
        const elifMatch = txt.match(/^elif\s+(.+)$/i);
        if (elifMatch) {
          activeIfCondition = elifMatch[1].trim();
          continue;
        }

        // else
        if (/^else\b/i.test(txt)) {
          activeIfCondition = '!(' + (activeIfCondition || 'true') + ')';
          continue;
        }

        // endif
        if (/^endif\b/i.test(txt)) {
          activeIfCondition = null;
          continue;
        }

        // drawindexed = count, first_index, offset (일반 라인 또는 주석 라인)
        const checkStr = txt.startsWith(';') ? txt.replace(/^;\s*/, '') : txt;
        const drawMatch = checkStr.match(/^drawindexed\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (drawMatch) {
          const count = parseInt(drawMatch[1], 10);
          const firstIndex = parseInt(drawMatch[2], 10);
          const vertexOffset = parseInt(drawMatch[3], 10);

          let name = partComment || `Part_${overrideObj.parts.length + 1}`;
          name = name.replace(/\s*\(\d+\)$/, '').trim();

          overrideObj.parts.push({
            id: `${sec.name}_p${overrideObj.parts.length + 1}`,
            sectionName: sec.name,
            name,
            condition: activeIfCondition,
            count,
            firstIndex,
            vertexOffset,
          });

          partComment = '';
          continue;
        }

        // Draw = count, offset (버텍스 직접 그리기)
        const drawSimpleMatch = checkStr.match(/^draw\s*=\s*(\d+)\s*,\s*(\d+)/i);
        if (drawSimpleMatch) {
          const count = parseInt(drawSimpleMatch[1], 10);
          const offset = parseInt(drawSimpleMatch[2], 10);
          overrideObj.refs.drawCount = count;
          overrideObj.refs.drawOffset = offset;
        }
      }

      // ★ 사용자 지침: 파츠 목록에 blend, texcoord 등의 버퍼가 포함되지 않도록,
      // 오직 'ib =' 구문이 정의된 섹션만 메쉬 파츠 구성 대상으로 인정합니다.
      if (!overrideObj.refs.ib) {
        continue;
      }

      // 섹션에 ib가 있으나 drawindexed 라인이 별도로 기재되지 않은 경우 (단일 match_index_count 또는 auto 드로우)
      if (overrideObj.parts.length === 0) {
        const count = pendingDrawCount || overrideObj.matchIndexCount || overrideObj.refs.drawCount || 0;
        const firstIndex = pendingDrawCount !== null ? pendingDrawFirstIndex : (overrideObj.matchFirstIndex || 0);
        const vertexOffset = pendingDrawCount !== null ? pendingDrawOffset : 0;

        let fallbackName = partComment || sec.name.replace(/^TextureOverride/i, '');
        fallbackName = fallbackName.replace(/\s*\(\d+\)$/, '').trim();

        overrideObj.parts.push({
          id: `${sec.name}_p1`,
          sectionName: sec.name,
          name: fallbackName,
          condition: activeIfCondition,
          count,
          firstIndex,
          vertexOffset,
        });
      }

      if (overrideObj.parts.length > 0) {
        overrides.push(overrideObj);
      }
    }
  }

  return {
    constants,
    keyBindings,
    resources,
    overrides,
  };
}

/**
 * 간단한 조건식 평가 (예: "$dress == 1 || $dress == 3")
 */
export function evaluateCondition(conditionStr, variableValues) {
  if (!conditionStr) return true;

  try {
    let expr = conditionStr.replace(/\$([a-zA-Z0-9_]+)/g, (match, varName) => {
      const lower = ('$' + varName).toLowerCase();
      const val = variableValues[lower];
      return val !== undefined ? String(val) : '0';
    });

    const sanitized = expr.replace(/[^0-9=!><&|\(\)\s\.\-]/g, '');
    const fn = new Function(`return Boolean(${sanitized});`);
    return fn();
  } catch (err) {
    console.warn('[ini_parser] Condition eval error:', conditionStr, err);
    return true;
  }
}
