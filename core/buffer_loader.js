/**
 * core/buffer_loader.js
 * 3DMigoto/XXMI .buf 바이너리 파일(Position, Texcoord, Blend)과 .ib (Index Buffer)를 파싱하여
 * Three.js BufferGeometry에 직접 바인딩 가능한 TypedArray로 변환합니다.
 */

/**
 * 16비트 IEEE 754 Half-Float 디코더
 */
export function decodeHalfFloat(h) {
  const s = (h >> 15) & 0x0001;
  const e = (h >> 10) & 0x001f;
  const f = h & 0x03ff;

  if (e === 0) {
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  } else if (e === 31) {
    return f ? 0 : s ? -65504 : 65504;
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Position 버퍼 파싱 (.buf)
 * @param {Uint8Array} bytes
 * @param {number} stride - 기본값 40바이트 (XXMI 표준)
 * @returns {{ positions: Float32Array, normals: Float32Array | null, bounds: { min: number[], max: number[], center: number[], radius: number } }}
 */
export function parsePositionBuffer(bytes, stride = 40) {
  const vertexCount = Math.floor(bytes.byteLength / stride);
  const positions = new Float32Array(vertexCount * 3);
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const offset = i * stride;
    // DirectX 오른손/왼손 좌표계 변환: X 그대로, Y 상향, Z 반전 (-z)
    const x = dataView.getFloat32(offset, true);
    const y = dataView.getFloat32(offset + 4, true);
    const z = -dataView.getFloat32(offset + 8, true);

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;

  let maxRadiusSq = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - centerX;
    const dy = positions[i * 3 + 1] - centerY;
    const dz = positions[i * 3 + 2] - centerZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > maxRadiusSq) maxRadiusSq = distSq;
  }

  return {
    vertexCount,
    positions,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [centerX, centerY, centerZ],
      radius: Math.sqrt(maxRadiusSq) || 1,
    },
  };
}

/**
 * Texcoord 버퍼 파싱 (.buf)
 * 다중 버텍스 샘플링 기반 자동 휴리스틱을 통해 Float32 / HalfFloat 및 오프셋(4 or 0)을 100% 정확하게 판별합니다.
 * @param {Uint8Array} bytes
 * @param {number} stride - 기본값 20 또는 24
 * @param {number} vertexCount
 * @returns {Float32Array} UV 좌표 배열 (u, v 쌍)
 */
export function parseTexcoordBuffer(bytes, stride = 20, vertexCount = 0) {
  const count = vertexCount || Math.floor(bytes.byteLength / stride);
  const uvs = new Float32Array(count * 2);
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 지원 레이아웃 후보군
  // 1. HalfFloat at offset 4, 6 (Stride 24, 16 등 - Roxy 계열 표준)
  // 2. Float32 at offset 4, 8 (Stride 20, 12 등 - Pearl 계열 표준)
  // 3. Float32 at offset 0, 4 (순수 Float32 UV)
  // 4. HalfFloat at offset 0, 2 (순수 HalfFloat UV)
  const candidateConfigs = [
    { type: 'half', offsetU: 4, offsetV: 6, minStride: 8, preferredStrides: [24, 16] },
    { type: 'float', offsetU: 4, offsetV: 8, minStride: 12, preferredStrides: [20, 12] },
    { type: 'float', offsetU: 0, offsetV: 4, minStride: 8, preferredStrides: [8] },
    { type: 'half', offsetU: 0, offsetV: 2, minStride: 4, preferredStrides: [4] },
  ];

  // 처음 16개 버텍스를 샘플링하여 유효한 UV 좌표 점수 산출
  const sampleCount = Math.min(count, 16);
  let bestConfig = candidateConfigs[0];
  let bestScore = -9999;

  for (const cfg of candidateConfigs) {
    if (stride < cfg.minStride) continue;
    let score = 0;

    // 해당 스트라이드에 특화된 포맷인 경우 기본 가산점 부여
    if (cfg.preferredStrides && cfg.preferredStrides.includes(stride)) {
      score += 15;
    }

    for (let i = 0; i < sampleCount; i++) {
      const vOffset = i * stride;
      let u = 0, v = 0;
      if (cfg.type === 'half') {
        u = decodeHalfFloat(dataView.getUint16(vOffset + cfg.offsetU, true));
        v = decodeHalfFloat(dataView.getUint16(vOffset + cfg.offsetV, true));
      } else {
        u = dataView.getFloat32(vOffset + cfg.offsetU, true);
        v = dataView.getFloat32(vOffset + cfg.offsetV, true);
      }

      // 비정상 수치(NaN, Infinite) 즉시 감점
      if (Number.isNaN(u) || Number.isNaN(v) || !Number.isFinite(u) || !Number.isFinite(v)) {
        score -= 20;
        continue;
      }

      // 비정상 극소수(Subnormal/garbage float): 0이 아닌데 0.0005 미만인 경우
      // HalfFloat 바이트를 Float32로 오독했을 때 발생하는 전형적인 쓰레기 부동소수점 (e.g. 4.64E-14)
      if ((Math.abs(u) > 0 && Math.abs(u) < 0.0005) || (Math.abs(v) > 0 && Math.abs(v) < 0.0005)) {
        score -= 10;
        continue;
      }

      // 정상 범위를 크게 벗어난 값 감점
      if (u < -0.1 || u > 1.5 || v < -0.1 || v > 1.5) {
        score -= 10;
        continue;
      }

      // 텍스처 좌표 정상 범위 가산점
      if (u >= 0.01 && u <= 0.99 && v >= 0.01 && v <= 0.99) {
        score += 3;
      } else if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestConfig = cfg;
    }
  }

  // 최적의 포맷으로 전체 버퍼 추출
  const { type, offsetU, offsetV } = bestConfig;
  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    let u = 0, v = 0;

    if (type === 'half') {
      u = decodeHalfFloat(dataView.getUint16(offset + offsetU, true));
      v = decodeHalfFloat(dataView.getUint16(offset + offsetV, true));
    } else {
      u = dataView.getFloat32(offset + offsetU, true);
      v = dataView.getFloat32(offset + offsetV, true);
    }

    // WebGL V축 반전 보정 (DirectX V는 아래로 증가, WebGL은 위로 증가)
    uvs[i * 2 + 0] = u;
    uvs[i * 2 + 1] = 1.0 - v;
  }

  return uvs;
}

/**
 * 인덱스 버퍼 파싱 (.ib)
 * @param {Uint8Array} bytes
 * @param {string} format - 'DXGI_FORMAT_R32_UINT' 또는 'DXGI_FORMAT_R16_UINT'
 * @returns {Uint32Array | Uint16Array}
 */
export function parseIndexBuffer(bytes, format = 'DXGI_FORMAT_R32_UINT') {
  const is16Bit = format.toUpperCase().includes('R16');

  if (is16Bit) {
    const count = Math.floor(bytes.byteLength / 2);
    if (bytes.byteOffset % 2 === 0) {
      return new Uint16Array(bytes.buffer, bytes.byteOffset, count);
    }
    const copy = new Uint16Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) {
      copy[i] = view.getUint16(i * 2, true);
    }
    return copy;
  }

  // 32-bit UINT
  const count = Math.floor(bytes.byteLength / 4);
  if (bytes.byteOffset % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
  }
  const copy = new Uint32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    copy[i] = view.getUint32(i * 4, true);
  }
  return copy;
}
