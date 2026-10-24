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
 * @param {Uint8Array} bytes
 * @param {number} stride - 기본값 24바이트
 * @param {number} vertexCount
 * @returns {Float32Array} UV 좌표 배열 (u, v 쌍)
 */
export function parseTexcoordBuffer(bytes, stride = 24, vertexCount = 0) {
  const count = vertexCount || Math.floor(bytes.byteLength / stride);
  const uvs = new Float32Array(count * 2);
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let isHalfFloat = true;

  if (bytes.byteLength >= stride) {
    const testH1 = dataView.getUint16(4, true);
    const testH2 = dataView.getUint16(6, true);
    const val1 = decodeHalfFloat(testH1);
    const val2 = decodeHalfFloat(testH2);

    if (val1 >= -0.5 && val1 <= 2.0 && val2 >= -0.5 && val2 <= 2.0) {
      isHalfFloat = true;
    } else {
      const f1 = dataView.getFloat32(0, true);
      const f2 = dataView.getFloat32(4, true);
      if (f1 >= -1 && f1 <= 2 && f2 >= -1 && f2 <= 2) {
        isHalfFloat = false;
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    let u = 0, v = 0;

    if (isHalfFloat) {
      const hu = dataView.getUint16(offset + 4, true);
      const hv = dataView.getUint16(offset + 6, true);
      u = decodeHalfFloat(hu);
      v = decodeHalfFloat(hv);
    } else {
      u = dataView.getFloat32(offset + 0, true);
      v = dataView.getFloat32(offset + 4, true);
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
