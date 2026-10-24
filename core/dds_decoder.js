/**
 * core/dds_decoder.js
 * DDS (DirectDraw Surface) 텍스처 헤더 파싱 및 WebGL 하드웨어 압축 텍스처(BPTC/BC7, S3TC/DXT) 또는
 * 일반 이미지(JPG, PNG) Blob 텍스처 변환기
 */

import * as THREE from '../libs/three.module.js';

// WebGL 상수 정의
const COMPRESSED_RGB_S3TC_DXT1_EXT = 0x83F0;
const COMPRESSED_RGBA_S3TC_DXT1_EXT = 0x83F1;
const COMPRESSED_RGBA_S3TC_DXT3_EXT = 0x83F2;
const COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83F3;
const COMPRESSED_RGBA_BPTC_UNORM_EXT = 0x8E8C;

/**
 * DDS 파일 Uint8Array를 Three.js 텍스처로 파싱
 * @param {Uint8Array} buffer
 * @param {THREE.WebGLRenderer} renderer
 * @returns {THREE.Texture | THREE.CompressedTexture | null}
 */
export function parseDdsTexture(buffer, renderer) {
  if (buffer.byteLength < 128) {
    console.warn('[dds_decoder] Buffer too small for DDS');
    return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = String.fromCharCode(
    buffer[0], buffer[1], buffer[2], buffer[3]
  );

  if (magic !== 'DDS ') {
    console.warn('[dds_decoder] Invalid DDS magic:', magic);
    return null;
  }

  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const mipmapCount = Math.max(1, view.getUint32(28, true));
  const fourCC = String.fromCharCode(
    buffer[84], buffer[85], buffer[86], buffer[87]
  );

  let dataOffset = 128;
  let dxgiFormat = 0;

  if (fourCC === 'DX10') {
    dataOffset = 148;
    dxgiFormat = view.getUint32(128, true);
  }

  const gl = renderer ? renderer.getContext() : null;
  const bptcExt = gl ? (gl.getExtension('WEBGL_compressed_texture_bptc') || gl.getExtension('EXT_texture_compression_bptc')) : null;
  const s3tcExt = gl ? (gl.getExtension('WEBGL_compressed_texture_s3tc') || gl.getExtension('WEBGL_compressed_texture_s3tc_srgb')) : null;

  // 1. BC7 포맷 (DXGI 98: BC7_TYPELESS, 99: BC7_UNORM, 100: BC7_UNORM_SRGB)
  if (fourCC === 'DX10' && (dxgiFormat === 98 || dxgiFormat === 99 || dxgiFormat === 100)) {
    if (bptcExt) {
      const glFormat = COMPRESSED_RGBA_BPTC_UNORM_EXT;
      const mipmaps = extractMipmaps(buffer, dataOffset, width, height, mipmapCount, 16);
      const texture = new THREE.CompressedTexture(mipmaps, width, height, glFormat);
      texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    } else {
      console.warn('[dds_decoder] WEBGL_compressed_texture_bptc extension not supported on this device/context.');
    }
  }

  // 2. DXT1 / BC1 포맷
  if (fourCC === 'DXT1' || (fourCC === 'DX10' && (dxgiFormat === 70 || dxgiFormat === 71 || dxgiFormat === 72))) {
    if (s3tcExt) {
      const glFormat = COMPRESSED_RGBA_S3TC_DXT1_EXT;
      const mipmaps = extractMipmaps(buffer, dataOffset, width, height, mipmapCount, 8);
      const texture = new THREE.CompressedTexture(mipmaps, width, height, glFormat);
      texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    }
  }

  // 3. DXT5 / BC3 포맷
  if (fourCC === 'DXT5' || (fourCC === 'DX10' && (dxgiFormat === 76 || dxgiFormat === 77 || dxgiFormat === 78))) {
    if (s3tcExt) {
      const glFormat = COMPRESSED_RGBA_S3TC_DXT5_EXT;
      const mipmaps = extractMipmaps(buffer, dataOffset, width, height, mipmapCount, 16);
      const texture = new THREE.CompressedTexture(mipmaps, width, height, glFormat);
      texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    }
  }

  // 폴백: 단색 캔버스 텍스처 반환
  console.info('[dds_decoder] Falling back to default textured canvas for DDS');
  return createFallbackTexture(width, height);
}

/**
 * Mipmap 버퍼 슬라이스 추출
 */
function extractMipmaps(buffer, offset, width, height, count, blockSize) {
  const mipmaps = [];
  let w = width;
  let h = height;
  let currOffset = offset;

  for (let i = 0; i < count; i++) {
    const blocksW = Math.max(1, Math.floor((w + 3) / 4));
    const blocksH = Math.max(1, Math.floor((h + 3) / 4));
    const dataLength = blocksW * blocksH * blockSize;

    if (currOffset + dataLength > buffer.byteLength) {
      break;
    }

    const data = new Uint8Array(buffer.buffer, buffer.byteOffset + currOffset, dataLength);
    mipmaps.push({ data, width: w, height: h });

    currOffset += dataLength;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }

  return mipmaps;
}

/**
 * 일반 이미지 (JPG, PNG) 바이너리를 Three.js Texture로 비동기 변환
 * @param {Uint8Array} buffer
 * @param {string} mimeType
 * @returns {Promise<THREE.Texture>}
 */
export async function loadImageTexture(buffer, mimeType = 'image/jpeg') {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const texture = new THREE.Texture(img);
      texture.needsUpdate = true;
      texture.colorSpace = THREE.SRGBColorSpace;
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
