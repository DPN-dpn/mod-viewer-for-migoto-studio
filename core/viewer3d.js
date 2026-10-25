/**
 * core/viewer3d.js
 * Three.js 기반 3D 메쉬 뷰어 엔진.
 * 오빗 컨트롤, PBR 조명, 그리드, 서브메쉬별 실시간 가시성 토글을 지원합니다.
 */

import * as THREE from '../libs/three.module.js';
import { OrbitControls } from '../libs/OrbitControls.js';
import { evaluateCondition } from './ini_parser.js';

export class ModViewer3D {
  /**
   * @param {HTMLElement} containerElement
   */
  constructor(containerElement) {
    this.container = containerElement;
    this.animationFrameId = null;
    this.isAutoRotate = false;
    this.isWireframe = false;
    this.modelGroup = new THREE.Group();
    this.orientationGroup = new THREE.Group();
    this.modelGroup.add(this.orientationGroup);

    this.currentUpAxis = '+Y';
    this.currentForwardAxis = '-Z';
    this.originalBounds = null;

    this.partMeshes = []; // { partInfo, mesh }
    this.materials = [];
    this.material = null;
    this.defaultTexture = null;
    this.activeVariables = {};
    this.enabledInis = null;

    this.initScene();
    this.initLights();
    this.initControls();
    this.initResizeObserver();
    this.animate();
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x13171f);

    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);
    this.camera.position.set(0, 1.2, 2.5);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    // 바닥 그리드
    this.grid = new THREE.GridHelper(10, 40, 0x3d475a, 0x222a36);
    this.grid.position.y = -0.001;
    this.scene.add(this.grid);

    this.scene.add(this.modelGroup);
  }

  initLights() {
    // 1. 전체 기본 조도 (Ambient Light: 그림자 없는 부드러운 기본 밝기 보장)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(this.ambientLight);

    // 2. 반구 환경광 (Hemisphere Light: 상단 흰색, 하단 부드러운 청회색)
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x475569, 0.6);
    this.hemiLight.position.set(0, 20, 0);
    this.scene.add(this.hemiLight);

    // 3. 주 조명 (Key Light: 우측 전방 상단)
    this.dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
    this.dirLight1.position.set(5, 10, 7);
    this.scene.add(this.dirLight1);

    // 4. 보조 조명 (Fill Light: 좌측 후방 상단)
    this.dirLight2 = new THREE.DirectionalLight(0xa5c4e8, 0.5);
    this.dirLight2.position.set(-5, 6, -5);
    this.scene.add(this.dirLight2);

    // 5. 카메라 헤드라이트 (어느 각도에서 오빗 회전하여도 항상 모델이 밝게 관찰되도록 카메라에 부착)
    this.cameraLight = new THREE.DirectionalLight(0xffffff, 0.45);
    this.camera.add(this.cameraLight);
    this.scene.add(this.camera);
  }

  initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 100;
    this.controls.target.set(0, 0.9, 0);
  }

  initResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObserver.observe(this.container);
  }

  onResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    this.animationFrameId = requestAnimationFrame(() => this.animate());

    if (this.isAutoRotate && this.modelGroup) {
      this.modelGroup.rotation.y += 0.008;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 단일 모델 데이터 로드 (하위 호환)
   */
  setModelData(data) {
    this.setComponents([data], data.initialVariables);
  }

  /**
   * 다중 컴포넌트 모델 데이터 로드 (모든 INI에서 수집된 복수 메쉬들)
   * @param {Array<{ name: string, iniName: string, positions: Float32Array, uvs: Float32Array | null, indices: Uint32Array | Uint16Array, parts: Array, diffuseTexture: any, normalTexture: any }>} components
   * @param {Record<string, number>} [initialVariables]
   * @param {string[] | Set<string> | null} [enabledInis=null]
   */
  setComponents(components, initialVariables = {}, enabledInis = null) {
    // 기존 메쉬 정리
    this.clearModel();

    this.activeVariables = { ...initialVariables };
    this.enabledInis = enabledInis ? new Set(enabledInis) : null;

    for (const comp of components) {
      const { name, iniName, positions, uvs, indices, parts, diffuseTexture, normalTexture } = comp;
      if (!positions || !indices) continue;

      // 컴포넌트별 머티리얼 구성 (애니메/게임 모드에 최적화된 자연스러운 PBR 파라미터)
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.75,
        metalness: 0.05,
        side: THREE.DoubleSide,
        wireframe: this.isWireframe,
        transparent: false,
        opacity: 1.0,
        map: diffuseTexture || null,
        normalMap: normalTexture || null,
      });

      if (normalTexture) {
        // DirectX 노말맵(Green 채널 반전/Y-down) 특성에 맞춰 Y축 음수 스케일 적용
        mat.normalScale = new THREE.Vector2(1.0, -1.0);
      }

      this.materials.push(mat);
      this.material = mat; // 마지막 머티리얼 참조 유지

      const posAttr = new THREE.BufferAttribute(positions, 3);
      const uvAttr = uvs && uvs.length > 0 ? new THREE.BufferAttribute(uvs, 2) : null;

      // 전체 컴포넌트 기준 버텍스 법선(Normal)을 1회만 계산하여 공유
      // 파츠마다 14만 정점 노말을 N번 중복 재계산하는 치명적 랙을 방지하고 접합면 스무딩 보장
      const baseGeo = new THREE.BufferGeometry();
      baseGeo.setAttribute('position', posAttr);
      baseGeo.setIndex(new THREE.BufferAttribute(indices, 1));
      baseGeo.computeVertexNormals();
      const normalAttr = baseGeo.getAttribute('normal');

      if (parts && parts.length > 0) {
        for (const part of parts) {
          const subIndices = indices.subarray(part.firstIndex, part.firstIndex + part.count);
          if (subIndices.length === 0) continue;

          const subGeo = new THREE.BufferGeometry();
          subGeo.setAttribute('position', posAttr);
          if (normalAttr) subGeo.setAttribute('normal', normalAttr);
          if (uvAttr) subGeo.setAttribute('uv', uvAttr);
          subGeo.setIndex(new THREE.BufferAttribute(subIndices, 1));

          // 각 파츠별로 독립된 머티리얼을 할당하여 파츠별 텍스처 교체를 지원합니다.
          const partMat = mat.clone();
          this.materials.push(partMat);

          const mesh = new THREE.Mesh(subGeo, partMat);
          mesh.name = `${iniName ? `[${iniName}] ` : ''}${part.name}`;
          mesh.castShadow = true;
          mesh.receiveShadow = true;

          this.orientationGroup.add(mesh);
          this.partMeshes.push({
            id: part.id || `${iniName}_${part.name}`,
            info: part,
            mesh,
            iniName: iniName || comp.iniName || null,
            customTextureFile: null,
          });
        }
      } else {
        // 단일 메쉬
        baseGeo.setAttribute('position', posAttr);
        if (normalAttr) baseGeo.setAttribute('normal', normalAttr);
        if (uvAttr) baseGeo.setAttribute('uv', uvAttr);

        const singleMat = mat.clone();
        this.materials.push(singleMat);

        const mesh = new THREE.Mesh(baseGeo, singleMat);
        mesh.name = name || 'Model';
        this.orientationGroup.add(mesh);
        this.partMeshes.push({
          id: name || 'Model',
          info: { name: name || 'Model', count: indices.length, firstIndex: 0 },
          mesh,
          iniName: iniName || comp.iniName || null,
          customTextureFile: null,
        });
      }
    }

    // 현재 설정된 기준 축 적용 및 그리드/시점 정렬
    this.applyOrientation();

    // 초기 토글 상태 적용
    this.updateToggles(this.activeVariables);
  }

  /**
   * 특정 파츠의 텍스처를 실시간으로 교체
   * @param {string} partIdentifier - part.id 또는 part.name 또는 sectionName
   * @param {THREE.Texture | null} texture - 교체할 텍스처 객체
   * @param {string | null} [textureFile=null] - 텍스처 파일명
   */
  setPartTexture(partIdentifier, texture, textureFile = null) {
    if (!partIdentifier) return;
    for (const item of this.partMeshes) {
      const match =
        item.id === partIdentifier ||
        item.info.id === partIdentifier ||
        item.info.name === partIdentifier ||
        item.mesh.name === partIdentifier ||
        (item.info.sectionName && item.info.sectionName === partIdentifier);

      if (match && item.mesh?.material) {
        item.mesh.material.map = texture || null;
        item.mesh.material.transparent = false;
        item.mesh.material.opacity = 1.0;
        item.mesh.material.needsUpdate = true;
        item.customTextureFile = textureFile;
      }
    }
  }

  /**
   * 기준 축 변경 (위쪽 Up, 앞쪽 Forward)
   * @param {string} upAxis - '+Y', '-Y', '+Z', '-Z', '+X', '-X'
   * @param {string} forwardAxis - '+Z', '-Z', '+Y', '-Y', '+X', '-X'
   * @param {boolean} [keepCamera=false] - 현재 카메라 시점 유지 여부
   */
  setOrientation(upAxis, forwardAxis, keepCamera = false) {
    this.currentUpAxis = upAxis || '+Y';
    this.currentForwardAxis = forwardAxis || '+Z';
    this.applyOrientation(keepCamera);
  }

  /**
   * 모델 로컬 축 -> Three.js 월드 축 정규직교 기저 행렬 적용
   * @param {boolean} [keepCamera=false]
   */
  applyOrientation(keepCamera = false) {
    const AXIS_VECTORS = {
      '+Y': new THREE.Vector3(0, 1, 0),
      '-Y': new THREE.Vector3(0, -1, 0),
      '+Z': new THREE.Vector3(0, 0, 1),
      '-Z': new THREE.Vector3(0, 0, -1),
      '+X': new THREE.Vector3(1, 0, 0),
      '-X': new THREE.Vector3(-1, 0, 0),
    };

    const modelUp = (AXIS_VECTORS[this.currentUpAxis] || new THREE.Vector3(0, 1, 0)).clone();
    let modelForward = (AXIS_VECTORS[this.currentForwardAxis] || new THREE.Vector3(0, 0, 1)).clone();

    // Up과 Forward가 평행인 경우 보정
    if (Math.abs(modelUp.dot(modelForward)) > 0.95) {
      if (Math.abs(modelUp.y) > 0.9) {
        modelForward = new THREE.Vector3(0, 0, 1);
      } else {
        modelForward = new THREE.Vector3(0, 1, 0);
      }
    }

    // Right = Up x Forward
    const modelRight = new THREE.Vector3().crossVectors(modelUp, modelForward).normalize();
    // Forward = Right x Up (직교 보정)
    const correctedForward = new THREE.Vector3().crossVectors(modelRight, modelUp).normalize();

    // Three.js 좌표계: Right=(1,0,0), Up=(0,1,0), Forward=(0,0,1)
    const basisMatrix = new THREE.Matrix4().set(
      modelRight.x, modelUp.x, correctedForward.x, 0,
      modelRight.y, modelUp.y, correctedForward.y, 0,
      modelRight.z, modelUp.z, correctedForward.z, 0,
      0, 0, 0, 1
    );

    // 모델 로컬 좌표를 월드 기준으로 맞추기 위한 역행렬
    const invMatrix = basisMatrix.invert();
    this.orientationGroup.matrix.copy(invMatrix);
    this.orientationGroup.matrix.decompose(
      this.orientationGroup.position,
      this.orientationGroup.quaternion,
      this.orientationGroup.scale
    );

    this.recenterAndAdjustGrid(keepCamera);
  }

  /**
   * 모델 회전 후 바운딩 박스를 기준으로 바닥 그리드 및 카메라 시점 재계산
   * @param {boolean} [keepCamera=false]
   */
  recenterAndAdjustGrid(keepCamera = false) {
    this.orientationGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.orientationGroup);

    if (box.isEmpty()) return;

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const radius = maxDim / 2;

    // 바닥 그리드를 모델 최하단으로 맞춤
    this.grid.position.y = box.min.y - 0.005;

    if (!keepCamera) {
      this.controls.target.set(center.x, center.y, center.z);
      const dist = Math.max(radius * 2.2, 1.2);
      this.camera.position.set(center.x, center.y + radius * 0.3, center.z + dist);
      this.camera.near = Math.max(0.01, radius / 50);
      this.camera.far = Math.max(100, radius * 20);
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * 활성화된 INI 목록 설정 (비활성화된 INI는 메모리에서 파괴하지 않고 숨김 처리)
   * @param {string[] | Set<string> | null} enabledInis
   * @returns {{ visibleTriangles: number, totalTriangles: number }}
   */
  setEnabledInis(enabledInis) {
    this.enabledInis = enabledInis ? new Set(enabledInis) : null;
    return this.updateToggles();
  }

  /**
   * 토글 변수 값 변경 시 파츠 가시성 실시간 갱신
   * @param {Record<string, number>} [variableValues]
   * @returns {{ visibleTriangles: number, totalTriangles: number }}
   */
  updateToggles(variableValues) {
    if (variableValues) {
      this.activeVariables = { ...this.activeVariables, ...variableValues };
    }

    let visibleTriangles = 0;
    let totalTriangles = 0;

    for (const item of this.partMeshes) {
      const { info, mesh, iniName } = item;
      const count = info.count || 0;

      // 비활성화된 INI의 파츠는 씬에서 visible=false 처리 (메모리 상주 유지)
      const isIniEnabled = !this.enabledInis || !iniName || this.enabledInis.has(iniName);

      if (isIniEnabled) {
        totalTriangles += Math.floor(count / 3);
      }

      const isConditionMet = evaluateCondition(info.condition, this.activeVariables);
      const isVisible = isIniEnabled && isConditionMet;
      mesh.visible = isVisible;

      if (isVisible) {
        visibleTriangles += Math.floor(count / 3);
      }
    }

    return { visibleTriangles, totalTriangles };
  }

  setWireframe(enabled) {
    this.isWireframe = enabled;
    for (const mat of this.materials) {
      mat.wireframe = enabled;
      mat.needsUpdate = true;
    }
  }

  setAutoRotate(enabled) {
    this.isAutoRotate = enabled;
    if (!enabled && this.modelGroup) {
      this.modelGroup.rotation.y = 0;
    }
  }

  setGridVisible(enabled) {
    if (this.grid) {
      this.grid.visible = enabled;
    }
  }

  setTheme(theme) {
    const isLight = theme === 'light';
    if (this.scene) {
      this.scene.background = new THREE.Color(isLight ? 0xedf2f7 : 0x13171f);
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      const centerColor = isLight ? 0x94a3b8 : 0x3d475a;
      const gridColor = isLight ? 0xcbd5e1 : 0x222a36;
      this.grid = new THREE.GridHelper(10, 40, centerColor, gridColor);
      this.grid.position.y = -0.001;
      this.scene.add(this.grid);
    }
  }

  resetCamera() {
    this.recenterAndAdjustGrid();
  }

  getCameraState() {
    if (!this.camera || !this.controls) return null;
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      target: {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z,
      },
      zoom: this.camera.zoom,
    };
  }

  setCameraState(state) {
    if (!state || !this.camera || !this.controls) return;
    if (state.position) {
      this.camera.position.set(state.position.x, state.position.y, state.position.z);
    }
    if (state.target) {
      this.controls.target.set(state.target.x, state.target.y, state.target.z);
    }
    if (state.zoom) {
      this.camera.zoom = state.zoom;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  clearModel() {
    for (const item of this.partMeshes) {
      this.orientationGroup.remove(item.mesh);
      item.mesh.geometry.dispose();
    }
    this.partMeshes = [];

    for (const mat of this.materials) {
      mat.dispose();
    }
    this.materials = [];
    this.material = null;
  }

  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.clearModel();

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }
  }
}
