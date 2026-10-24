/**
 * core/dds_decoder.js
 * Migoto Studio 내장 플러그인 'texture-library' (>=1.0.0)의 decodeDDS API를 호출하여
 * DDS 텍스처(BC1~BC7, sRGB/Linear)를 Three.js DataTexture로 변환합니다.
 * 자체 디코딩 코드를 중복 포함하지 않고 texture-library 플러그인에 종속성을 가집니다.
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
    // 1. 종속성 플러그인 'texture-library'의 공개 API 조회
    const texLib = context?.plugins?.getPluginApi?.('texture-library');

    if (!texLib || typeof texLib.decodeDDS !== 'function') {
      context?.logger?.warn('[3D 뷰어] 종속성 플러그인 "texture-library" (>=1.0.0)가 활성화되어 있지 않거나 decodeDDS API를 찾을 수 없습니다.');
      return createFallbackTexture(512, 512);
    }

    // 2. texture-library의 디코더 호출 (BC1~BC7, DX10, sRGB/Linear 판별 지원)
    const decoded = texLib.decodeDDS(buffer);
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

    // 5. Three.js DataTexture 생성
    const pixelData = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const texture = new THREE.DataTexture(
      pixelData,
      width,
      height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    // 저장 방식에 따른 sRGB vs Linear 색공간 정확한 적용
    texture.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    texture.needsUpdate = true;

    return texture;
  } catch (err) {
    context?.logger?.warn('[3D 뷰어] DDS 텍스처 로드 실패:', err);
    return createFallbackTexture(512, 512);
  }
}

/**
 * 일반 이미지 (JPG, PNG) 바이너리를 Three.js Texture로 비동기 변환
 * @param {Uint8Array} buffer
 * @param {string} mimeType
 * @param {boolean} [isSRGB=true]
 * @returns {Promise<THREE.Texture>}
 */
export async function loadImageTexture(buffer, mimeType = 'image/jpeg', isSRGB = true) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const texture = new THREE.Texture(img);
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
