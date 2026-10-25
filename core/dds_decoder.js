/**
 * core/dds_decoder.js
 * Migoto Studio 내장 플러그인 'texture-library' (>=1.0.0)의 decodeDDS API를 호출하여
 * DDS 텍스처(BC1~BC7, sRGB/Linear)를 Three.js DataTexture로 변환합니다.
 * 자체 디코더 코드를 중복 포함하지 않고 texture-library 플러그인의 종속성을 가집니다.
 */

import * as THREE from '../libs/three.module.js';

/**
 * GPU 최대 텍스처 해상도에 맞춘 안전한 다운샘플링 헬퍼
 */
function downsampleIfNeeded(rgba, width, height, maxSize = 4096) {
  if (width <= maxSize && height <= maxSize) {
    return { rgba, width, height };
  }

  const scale = Math.min(maxSize / width, maxSize / height);
  const targetW = Math.max(1, Math.floor(width * scale));
  const targetH = Math.max(1, Math.floor(height * scale));

  const newRgba = new Uint8ClampedArray(targetW * targetH * 4);
  const xRatio = width / targetW;
  const yRatio = height / targetH;

  for (let dy = 0; dy < targetH; dy++) {
    const sy = Math.min(height - 1, Math.floor(dy * yRatio));
    const sRow = sy * width * 4;
    const dRow = dy * targetW * 4;

    for (let dx = 0; dx < targetW; dx++) {
      const sx = Math.min(width - 1, Math.floor(dx * xRatio));
      const sIdx = sRow + sx * 4;
      const dIdx = dRow + dx * 4;

      newRgba[dIdx] = rgba[sIdx];
      newRgba[dIdx + 1] = rgba[sIdx + 1];
      newRgba[dIdx + 2] = rgba[sIdx + 2];
      newRgba[dIdx + 3] = rgba[sIdx + 3];
    }
  }

  return { rgba: newRgba, width: targetW, height: targetH };
}

/**
 * 2채널 노말맵(RG 포맷, Z 성분 누락 또는 B=128 더미) 자동 감지 및 Z축 재구성
 * ZZZ(젠레스 존 제로), 원신 등 호요버스/DirectX 계열 게임에서 노말맵 용량 절감을 위해
 * R=X, G=Y만 저장하고 B=128로 채워둔 2채널 노말맵을 Three.js 표준 3채널 탄젠트 노말맵으로 완벽 복원합니다.
 * Z가 0이면 표면 법선이 수평으로 꺾여 빛을 받을 때 극심한 자글거림(flickering)과 모델 깨짐이 발생합니다.
 * @param {Uint8ClampedArray | Uint8Array} data
 * @param {boolean} [forceNormal=false]
 * @returns {boolean}
 */
export function reconstructNormalZIfNeeded(data, forceNormal = false) {
  // Diffuse/Albedo 등 일반 텍스처는 절대 노말 Z 복원을 실행하지 않음 (색상 왜곡 방지)
  if (!forceNormal) return false;

  const len = data.length;
  if (len < 16) return false;

  const step = Math.max(4, Math.floor(len / 2000) * 4);
  let sampleCount = 0;
  let bSum = 0;

  for (let i = 0; i < len; i += step) {
    bSum += data[i + 2];
    sampleCount++;
  }

  const avgB = bSum / sampleCount;

  // 노말맵의 B 채널 평균이 100~160(약 128)인 2채널(RG 포맷)인 경우에만 Z 복원
  const isTwoChannel = avgB >= 100 && avgB <= 160;

  if (isTwoChannel) {
    for (let i = 0; i < len; i += 4) {
      const r = data[i];
      const g = data[i + 1];

      // [-1, 1] 범위로 정규화
      const nx = (r / 255) * 2 - 1;
      const ny = (g / 255) * 2 - 1;

      // Z = sqrt(max(0, 1 - X^2 - Y^2))
      const nzSq = 1.0 - (nx * nx + ny * ny);
      const nz = nzSq > 0 ? Math.sqrt(nzSq) : 0;

      // [0, 255] 범위로 재구성하여 B 채널에 복원
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
    return true;
  }

  return false;
}

/**
 * texture-library 플러그인의 decodeDDS API를 활용하여 Three.js Texture로 변환
 * @param {Uint8Array} buffer
 * @param {object | THREE.WebGLRenderer} contextOrRenderer - PluginContext 또는 WebGLRenderer
 * @param {THREE.WebGLRenderer | object} [maybeRenderer]
 * @param {object} [maybeOptions]
 * @param {boolean} [maybeOptions.isNormal=false]
 * @param {boolean} [maybeOptions.isDiffuse=true]
 * @returns {THREE.DataTexture | null}
 */
export function parseDdsTexture(buffer, contextOrRenderer = null, maybeRenderer = null, maybeOptions = {}) {
  let context = null;
  let renderer = null;
  let options = {};

  if (contextOrRenderer && (contextOrRenderer.plugins || contextOrRenderer.workspace || contextOrRenderer.logger)) {
    context = contextOrRenderer;
    renderer = maybeRenderer || null;
    options = maybeOptions || {};
  } else {
    renderer = contextOrRenderer || null;
    options = maybeRenderer || {};
    context = options.context || null;
  }

  try {
    // 1. 종속된 플러그인 'texture-library'의 공개 API 조회
    const texLib = context?.plugins?.getPluginApi?.('texture-library');

    if (!texLib || typeof texLib.decodeDDS !== 'function') {
      context?.logger?.warn('[3D 뷰어] 종속된 플러그인 "texture-library" (>=1.0.0)가 활성화되어 있지 않거나 decodeDDS API를 찾을 수 없습니다.');
      return createFallbackTexture(512, 512);
    }

    // 2. texture-library의 디코더 호출 (BC1~BC7, DX10, sRGB/Linear 판별 지원)
    const decoded = texLib.decodeDDS(buffer, { ignoreAlpha: true });
    if (!decoded || !decoded.rgba || !decoded.width || !decoded.height) {
      context?.logger?.warn('[3D 뷰어] texture-library를 통한 DDS 디코딩 결과가 올바르지 않습니다.');
      return createFallbackTexture(512, 512);
    }

    // 3. 노멀맵 또는 옵션에 따른 sRGB/Linear 색공간 확정
    const isSRGB = options.isNormal ? false : Boolean(decoded.isSRGB);

    // 4. GPU 최대 텍스처 해상도 초과 방지
    const gl = renderer?.getContext?.();
    const maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096 : 4096;
    const { rgba, width, height } = downsampleIfNeeded(decoded.rgba, decoded.width, decoded.height, maxTextureSize);

    // 5. Canvas 2D 기반 CanvasTexture 생성 (알파 무시 255 불투명 보장 및 WebGL 완벽 호환)
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const clamped = (rgba instanceof Uint8ClampedArray)
      ? rgba
      : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);

    if (options.isNormal) {
      reconstructNormalZIfNeeded(clamped, true);
    }

    // 알파 채널 무시 (모든 픽셀 완전 불투명 처리):
    // 3DMigoto 모드에서는 알파 채널을 스펙큘러, 글로우, 디졸브, 투명도 마스크 등으로 사용하는 경우가 많아
    // 알파를 그대로 두면 모델 파츠가 투명해지거나 부분적으로 보이지 않는 문제가 발생함.
    // 모든 픽셀의 알파를 255로 강제하여 텍스처 내용이 온전히 보이도록 함.
    for (let i = 3; i < clamped.length; i += 4) {
      clamped[i] = 255;
    }

    const imgData = new ImageData(clamped, width, height);
    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    texture.needsUpdate = true;

    context?.logger?.info(`[3D 뷰어] DDS 텍스처 적용 완료 (알파 무시): ${width}x${height} (${decoded.format}), sRGB: ${isSRGB}`);

    return texture;
  } catch (err) {
    context?.logger?.warn('[3D 뷰어] DDS 텍스처 로드 실패:', err);
    return createFallbackTexture(512, 512);
  }
}

/**
 * 일반 이미지 (JPG, PNG) 바이너리를 Three.js Texture로 비동기 변환 (알파 무시 및 2채널 노말맵 복원)
 * @param {Uint8Array} buffer
 * @param {string} mimeType
 * @param {boolean} [isSRGB=true]
 * @param {object | boolean} [options={}]
 * @returns {Promise<THREE.Texture>}
 */
export async function loadImageTexture(buffer, mimeType = 'image/jpeg', isSRGB = true, options = {}) {
  const isNormal = typeof options === 'boolean' ? options : Boolean(options?.isNormal);

  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      try {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;

        // 2채널 노말맵 복원
        if (isNormal) {
          reconstructNormalZIfNeeded(data, true);
        }

        // 알파 채널 무시: 모든 픽셀 완전 불투명(255) 처리
        for (let i = 3; i < data.length; i += 4) {
          data[i] = 255;
        }

        ctx.putImageData(imgData, 0, 0);
      } catch (e) {
        // ImageData 변환 실패 시 캔버스 원본 유지
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      texture.needsUpdate = true;
      resolve(texture);
    };

    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };

    img.src = url;
  });
}

/**
 * 기본 그리드 스타일 폴백 텍스처
 */
function createFallbackTexture(width = 512, height = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(512, width);
  canvas.height = Math.min(512, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#b0b8c4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#8f9aa9';
  const size = 32;
  for (let y = 0; y < canvas.height; y += size * 2) {
    for (let x = 0; x < canvas.width; x += size * 2) {
      ctx.fillRect(x, y, size, size);
      ctx.fillRect(x + size, y + size, size, size);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}