import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Check,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Grid3X3,
  ImagePlus,
  Layers,
  Maximize2,
  Moon,
  Plus,
  RotateCcw,
  Ruler,
  Square,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const TILE_SIZE_MIN = 0.001;
const TILE_SIZE_MAX = 3;
const TILE_SIZE_STEP = 0.001;
const EXPOSURE_MIN = 0.35;
const EXPOSURE_MAX = 1.8;
const EXPOSURE_STEP = 0.05;
const LIGHT_MIN = 0.5;
const LIGHT_MAX = 2;
const LIGHT_STEP = 0.05;
const MATERIAL_MIN = 0;
const MATERIAL_MAX = 1;
const MATERIAL_STEP = 0.01;
const FABRIC_TEXTURE_CONTRAST = 1.56;
const FABRIC_TEXTURE_BRIGHTNESS = -22;
const ASSET_DB_NAME = "fabric-bake-assets";
const ASSET_DB_VERSION = 1;
const ASSET_STORE_NAME = "uploads";
const VIEW_OPTIONS_STORAGE_KEY = "fabric-bake-view-options";
const LAYERS_STORAGE_KEY = "fabric-bake-layers";
const VIEW_OPTIONS_VERSION = 6;
const DEFAULT_LAYER_ID = "preview-layer";
const DEFAULT_FABRIC_NAME = "Default Herringbone";
const DEFAULT_FABRIC_URL = "/local-assets/fabrics/default-herringbone-fabric.png";

const DEFAULT_VIEW_OPTIONS = {
  viewPresetVersion: VIEW_OPTIONS_VERSION,
  darkMode: false,
  grid: false,
  autoRotate: false,
  transparentBackground: false,
  bakeInBrowser: true,
  fabricPreview: true,
  exposure: 0.88,
  lightIntensity: 1,
  fabricTileWidth: 0.3,
  fabricTileHeight: 0.3,
  fabricRoughness: 0.9,
  fabricMetalness: 0,
};

const STUDIO_VIEW_OVERRIDES = {
  viewPresetVersion: VIEW_OPTIONS_VERSION,
  darkMode: false,
  grid: false,
  exposure: DEFAULT_VIEW_OPTIONS.exposure,
  lightIntensity: DEFAULT_VIEW_OPTIONS.lightIntensity,
  fabricTileWidth: DEFAULT_VIEW_OPTIONS.fabricTileWidth,
  fabricTileHeight: DEFAULT_VIEW_OPTIONS.fabricTileHeight,
};

const DEFAULT_LAYER = {
  id: DEFAULT_LAYER_ID,
  name: "Base Layer",
  source: null,
  isRemote: true,
  isPreview: true,
  assetKey: null,
  visible: true,
  bakeFabric: true,
};

const measurementFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});

function makeLayerId() {
  return crypto.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeLayerAssetKey(layerId) {
  return `layer-model:${layerId}`;
}

function makeLayerName(layers) {
  return `Layer ${layers.length + 1}`;
}

function getMeshStats(root) {
  let meshes = 0;
  const materials = new Set();
  let triangles = 0;

  root.traverse((node) => {
    if (!node.isMesh || !node.visible) return;
    meshes += 1;
    if (Array.isArray(node.material)) {
      node.material.forEach((material) => materials.add(material.uuid));
    } else if (node.material) {
      materials.add(node.material.uuid);
    }
    const position = node.geometry?.attributes?.position;
    if (node.geometry?.index) {
      triangles += node.geometry.index.count / 3;
    } else if (position) {
      triangles += position.count / 3;
    }
  });

  return {
    meshes,
    materials: materials.size,
    triangles: Math.round(triangles),
  };
}

function formatSize(value) {
  return measurementFormatter.format(value);
}

function clampTileSize(value) {
  return Math.min(TILE_SIZE_MAX, Math.max(TILE_SIZE_MIN, value));
}

function clampExposure(value) {
  return Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, value));
}

function clampLightIntensity(value) {
  return Math.min(LIGHT_MAX, Math.max(LIGHT_MIN, value));
}

function clampMaterialValue(value) {
  return Math.min(MATERIAL_MAX, Math.max(MATERIAL_MIN, value));
}

function formatTileSize(value) {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatExposure(value) {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatLightIntensity(value) {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMaterialValue(value) {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function makeDownloadName(activeLayerName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = activeLayerName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "");
  return `${baseName || "viewport"}-${timestamp}.png`;
}

function normalizeViewOptions(options = {}) {
  const normalizedOptions = {
    ...DEFAULT_VIEW_OPTIONS,
    ...options,
    exposure: Number.isFinite(Number(options.exposure))
      ? clampExposure(Number(options.exposure))
      : DEFAULT_VIEW_OPTIONS.exposure,
    lightIntensity: Number.isFinite(Number(options.lightIntensity))
      ? clampLightIntensity(Number(options.lightIntensity))
      : DEFAULT_VIEW_OPTIONS.lightIntensity,
    fabricTileWidth: clampTileSize(Number(options.fabricTileWidth) || DEFAULT_VIEW_OPTIONS.fabricTileWidth),
    fabricTileHeight: clampTileSize(
      Number(options.fabricTileHeight) || DEFAULT_VIEW_OPTIONS.fabricTileHeight,
    ),
    fabricRoughness: Number.isFinite(Number(options.fabricRoughness))
      ? clampMaterialValue(Number(options.fabricRoughness))
      : DEFAULT_VIEW_OPTIONS.fabricRoughness,
    fabricMetalness: Number.isFinite(Number(options.fabricMetalness))
      ? clampMaterialValue(Number(options.fabricMetalness))
      : DEFAULT_VIEW_OPTIONS.fabricMetalness,
  };

  if (Number(options.viewPresetVersion) !== VIEW_OPTIONS_VERSION) {
    return {
      ...normalizedOptions,
      ...STUDIO_VIEW_OVERRIDES,
    };
  }

  return normalizedOptions;
}

function normalizeLayer(layer, fallbackIndex = 0) {
  const id = typeof layer?.id === "string" && layer.id ? layer.id : makeLayerId();
  return {
    id,
    name:
      typeof layer?.name === "string" && layer.name.trim()
        ? layer.name.trim()
        : fallbackIndex === 0
          ? DEFAULT_LAYER.name
          : `Layer ${fallbackIndex + 1}`,
    source: null,
    isRemote: Boolean(layer?.isRemote),
    isPreview: Boolean(layer?.isPreview),
    assetKey: typeof layer?.assetKey === "string" ? layer.assetKey : null,
    visible: layer?.visible !== false,
    bakeFabric: Boolean(layer?.bakeFabric),
  };
}

function getStoredLayerMetadata() {
  try {
    const rawLayers = JSON.parse(window.localStorage.getItem(LAYERS_STORAGE_KEY) || "[]");
    if (!Array.isArray(rawLayers) || rawLayers.length === 0) return [DEFAULT_LAYER];
    return rawLayers.map(normalizeLayer);
  } catch {
    return [DEFAULT_LAYER];
  }
}

function serializeLayers(layers) {
  return layers.map(({ id, name, isRemote, isPreview, assetKey, visible, bakeFabric }) => ({
    id,
    name,
    isRemote,
    isPreview,
    assetKey,
    visible,
    bakeFabric,
  }));
}

function readStoredViewOptions() {
  try {
    const storedOptions = window.localStorage.getItem(VIEW_OPTIONS_STORAGE_KEY);
    return normalizeViewOptions(storedOptions ? JSON.parse(storedOptions) : DEFAULT_VIEW_OPTIONS);
  } catch {
    return DEFAULT_VIEW_OPTIONS;
  }
}

function openAssetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB_NAME, ASSET_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
        request.result.createObjectStore(ASSET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredAsset(key) {
  const db = await openAssetDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ASSET_STORE_NAME, "readonly");
    const request = transaction.objectStore(ASSET_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function saveStoredAsset(key, file) {
  const db = await openAssetDb();
  const record = {
    blob: file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    savedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ASSET_STORE_NAME, "readwrite");
    const request = transaction.objectStore(ASSET_STORE_NAME).put(record, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

function createPreviewForm() {
  const group = new THREE.Group();
  group.name = "Preview Form";

  const formMaterial = new THREE.MeshStandardMaterial({
    color: 0xc7c1b8,
    roughness: 0.72,
    metalness: 0.02,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x394448,
    roughness: 0.64,
    metalness: 0.04,
  });

  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.74, 48, 28), formMaterial);
  torso.name = "Torso";
  torso.scale.set(0.78, 1.24, 0.38);
  torso.position.y = 0.72;
  group.add(torso);

  const waist = new THREE.Mesh(new THREE.SphereGeometry(0.54, 40, 20), formMaterial);
  waist.name = "Waist";
  waist.scale.set(0.86, 0.36, 0.34);
  waist.position.y = -0.02;
  group.add(waist);

  const shoulder = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 1.36, 12, 28), formMaterial);
  shoulder.name = "Shoulder";
  shoulder.rotation.z = Math.PI / 2;
  shoulder.scale.z = 0.55;
  shoulder.position.y = 1.42;
  group.add(shoulder);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.34, 32), trimMaterial);
  neck.name = "Neck";
  neck.position.y = 1.86;
  group.add(neck);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.72, 0.08, 48), trimMaterial);
  base.name = "Base";
  base.position.y = -0.42;
  group.add(base);

  return group;
}

function disposeObject(root, materialSkipSet = new Set()) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    const activeMaterials = Array.isArray(node.material) ? node.material : [node.material];
    const originalMaterials = node.userData.originalMaterial
      ? Array.isArray(node.userData.originalMaterial)
        ? node.userData.originalMaterial
        : [node.userData.originalMaterial]
      : [];
    const materials = [...activeMaterials, ...originalMaterials];
    materials.filter(Boolean).forEach((material) => {
      if (materialSkipSet.has(material.uuid)) return;
      Object.values(material).forEach((value) => {
        if (value?.isTexture) value.dispose();
      });
      material.dispose();
    });
  });
}

function createAdjustedFabricTexture(sourceTexture) {
  const image = sourceTexture.image;
  const width = image?.naturalWidth || image?.videoWidth || image?.width;
  const height = image?.naturalHeight || image?.videoHeight || image?.height;

  if (!image || !width || !height) {
    return sourceTexture;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return sourceTexture;

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const nextValue =
        (data[index + channel] - 128) * FABRIC_TEXTURE_CONTRAST +
        128 +
        FABRIC_TEXTURE_BRIGHTNESS;
      data[index + channel] = Math.max(0, Math.min(255, nextValue));
    }
  }

  context.putImageData(imageData, 0, 0);
  sourceTexture.dispose();

  return new THREE.CanvasTexture(canvas);
}

function App() {
  const viewportRef = useRef(null);
  const layerFileInputRef = useRef(null);
  const textureInputRef = useRef(null);
  const sceneApiRef = useRef(null);
  const pendingLayerUploadRef = useRef(DEFAULT_LAYER_ID);
  const layersRef = useRef([]);
  const [sceneReady, setSceneReady] = useState(false);
  const [activeTab, setActiveTab] = useState("layers");
  const [layers, setLayers] = useState(() => getStoredLayerMetadata());
  const [selectedLayerId, setSelectedLayerId] = useState(() => getStoredLayerMetadata()[0]?.id ?? DEFAULT_LAYER_ID);
  const [modelStats, setModelStats] = useState(null);
  const [loadState, setLoadState] = useState({ status: "loading", message: "" });
  const [isDragging, setIsDragging] = useState(false);
  const [viewOptions, setViewOptions] = useState(readStoredViewOptions);
  const [tileInputs, setTileInputs] = useState(() => {
    const initialOptions = readStoredViewOptions();
    return {
      fabricTileWidth: formatTileSize(initialOptions.fabricTileWidth),
      fabricTileHeight: formatTileSize(initialOptions.fabricTileHeight),
    };
  });
  const [fabricTextureName, setFabricTextureName] = useState(DEFAULT_FABRIC_NAME);
  const [fabricTexture, setFabricTexture] = useState(null);

  const selectedLayer = useMemo(
    () => layers.find((layer) => layer.id === selectedLayerId) ?? layers[0] ?? DEFAULT_LAYER,
    [layers, selectedLayerId],
  );

  const fabricRepeat = useMemo(() => {
    const size = modelStats?.size ?? { x: 1, y: 1, z: 1 };
    const horizontalSpan = Math.max(size.x, size.z, 1);
    const verticalSpan = Math.max(size.y, 1);
    return {
      x: horizontalSpan / viewOptions.fabricTileWidth,
      y: verticalSpan / viewOptions.fabricTileHeight,
    };
  }, [modelStats, viewOptions.fabricTileHeight, viewOptions.fabricTileWidth]);

  const summaryItems = useMemo(() => {
    if (!modelStats) return [];
    return [
      ["Layers", layers.filter((layer) => layer.visible).length],
      ["Meshes", modelStats.meshes],
      ["Materials", modelStats.materials],
      ["Triangles", modelStats.triangles.toLocaleString()],
      [
        "Bounds",
        `${formatSize(modelStats.size.x)} x ${formatSize(modelStats.size.y)} x ${formatSize(
          modelStats.size.z,
        )}`,
      ],
    ];
  }, [layers, modelStats]);

  useEffect(() => {
    if (!viewportRef.current) return;

    const container = viewportRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xefefed);

    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 1000);
    camera.position.set(2.8, 1.6, 3.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = viewOptions.exposure;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const studioEnvironment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = studioEnvironment;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.autoRotateSpeed = 1.2;

    const baseKeyIntensity = 1.44;
    const baseFillIntensity = 0.74;
    const baseFrontIntensity = 0.42;
    const baseRimIntensity = 0.58;
    const baseAmbientIntensity = 0.56;

    const key = new THREE.DirectionalLight(0xffffff, baseKeyIntensity);
    key.position.set(-3.4, 5.6, 4.4);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, baseFillIntensity);
    fill.position.set(4.4, 3.6, 4.8);
    scene.add(fill);

    const front = new THREE.DirectionalLight(0xffffff, baseFrontIntensity);
    front.position.set(0, 2.6, 6.4);
    scene.add(front);

    const rim = new THREE.DirectionalLight(0xe8eef2, baseRimIntensity);
    rim.position.set(-3.2, 4.6, -4.8);
    scene.add(rim);

    const ambient = new THREE.HemisphereLight(0xffffff, 0xd8d5cf, baseAmbientIntensity);
    scene.add(ambient);

    const grid = new THREE.GridHelper(10, 20, 0x405760, 0x1b2b31);
    grid.position.y = -0.01;
    scene.add(grid);

    const modelRoot = new THREE.Group();
    scene.add(modelRoot);

    const fabricOverlayMaterial = new THREE.MeshStandardMaterial({
      color: 0x8f908a,
      roughness: viewOptions.fabricRoughness,
      metalness: viewOptions.fabricMetalness,
      envMapIntensity: 0.16,
      transparent: false,
      opacity: 1,
    });
    const sharedMaterials = new Set([fabricOverlayMaterial.uuid]);
    const layerObjects = new Map();
    const loadTickets = new Map();
    const fabricBounds = new THREE.Vector3(1, 1, 1);
    let currentOptions = { ...viewOptions };
    let currentLayers = layers;

    function resize() {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function getVisibleBox() {
      const box = new THREE.Box3();
      let hasVisibleObject = false;
      modelRoot.children.forEach((child) => {
        if (!child.visible) return;
        box.expandByObject(child);
        hasVisibleObject = true;
      });
      return hasVisibleObject ? box : null;
    }

    function updateStats() {
      const box = getVisibleBox();
      if (!box) {
        setModelStats(null);
        return;
      }
      const size = box.getSize(new THREE.Vector3());
      fabricBounds.copy(size);
      applyTileRepeat();
      setModelStats({
        ...getMeshStats(modelRoot),
        size,
      });
    }

    function frameScene() {
      const box = getVisibleBox();
      if (!box) {
        setModelStats(null);
        return;
      }

      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxSize = Math.max(size.x, size.y, size.z) || 1;
      const fitDistance = maxSize / (2 * Math.tan((camera.fov * Math.PI) / 360));
      const direction = new THREE.Vector3(0, 0.16, 1).normalize();

      controls.target.copy(center);
      camera.near = Math.max(maxSize / 1000, 0.001);
      camera.far = Math.max(maxSize * 100, 100);
      camera.position.copy(center).add(direction.multiplyScalar(fitDistance * 1.18));
      camera.updateProjectionMatrix();
      controls.update();

      grid.position.y = box.min.y;
      grid.scale.setScalar(Math.max(maxSize / 4, 0.5));
      fabricBounds.copy(size);
      applyTileRepeat();
      updateStats();
    }

    function exportViewport(fileName) {
      controls.update();
      renderer.render(scene, camera);
      renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }, "image/png");
    }

    function getTileRepeat() {
      const horizontalSpan = Math.max(fabricBounds.x, fabricBounds.z, 1);
      const verticalSpan = Math.max(fabricBounds.y, 1);
      return {
        x: Math.max(horizontalSpan / Math.max(currentOptions.fabricTileWidth, TILE_SIZE_MIN), 0.01),
        y: Math.max(verticalSpan / Math.max(currentOptions.fabricTileHeight, TILE_SIZE_MIN), 0.01),
      };
    }

    function applyTileRepeat() {
      if (!fabricOverlayMaterial.map) return;
      const repeat = getTileRepeat();
      fabricOverlayMaterial.map.repeat.set(repeat.x, repeat.y);
      fabricOverlayMaterial.map.needsUpdate = true;
    }

    function applyFabricTexture(texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      if (fabricOverlayMaterial.map) fabricOverlayMaterial.map.dispose();
      fabricOverlayMaterial.map = texture;
      applyTileRepeat();
      fabricOverlayMaterial.needsUpdate = true;
    }

    function setLayerFabric(object, enabled) {
      object.traverse((node) => {
        if (!node.isMesh) return;
        if (enabled && currentOptions.fabricPreview) {
          node.userData.originalMaterial ??= node.material;
          node.material = fabricOverlayMaterial;
        } else if (node.userData.originalMaterial) {
          node.material = node.userData.originalMaterial;
        }
      });
    }

    function removeLayerObject(layerId) {
      const record = layerObjects.get(layerId);
      if (!record) return;
      modelRoot.remove(record.object);
      disposeObject(record.object, sharedMaterials);
      layerObjects.delete(layerId);
    }

    function setLayerObject(layer, object) {
      removeLayerObject(layer.id);
      object.name = layer.name;
      object.userData.layerId = layer.id;
      object.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
      });
      object.visible = layer.visible;
      modelRoot.add(object);
      layerObjects.set(layer.id, {
        object,
        source: layer.source,
        isPreview: layer.isPreview,
      });
      setLayerFabric(object, layer.bakeFabric);
      frameScene();
    }

    function loadLayer(layer) {
      if (!layer.source && !layer.isPreview) {
        removeLayerObject(layer.id);
        updateStats();
        return;
      }

      const record = layerObjects.get(layer.id);
      if (record && record.source === layer.source && record.isPreview === layer.isPreview) {
        record.object.name = layer.name;
        record.object.visible = layer.visible;
        setLayerFabric(record.object, layer.bakeFabric);
        updateStats();
        return;
      }

      const ticket = (loadTickets.get(layer.id) ?? 0) + 1;
      loadTickets.set(layer.id, ticket);
      setLoadState({ status: "loading", message: "" });

      if (layer.isPreview) {
        setLayerObject(layer, createPreviewForm());
        setLoadState({ status: "ready", message: "" });
        return;
      }

      const loader = new GLTFLoader();
      loader.load(
        layer.source,
        (gltf) => {
          if (loadTickets.get(layer.id) !== ticket) {
            disposeObject(gltf.scene, sharedMaterials);
            return;
          }
          setLayerObject(layer, gltf.scene);
          setLoadState({ status: "ready", message: "" });
        },
        undefined,
        (error) => {
          if (loadTickets.get(layer.id) !== ticket) return;
          console.error(error);
          removeLayerObject(layer.id);
          setLoadState({
            status: "error",
            message: `Could not read ${layer.name}.`,
          });
          updateStats();
        },
      );
    }

    function loadLayers(nextLayers) {
      currentLayers = nextLayers;
      const nextIds = new Set(nextLayers.map((layer) => layer.id));
      Array.from(layerObjects.keys()).forEach((layerId) => {
        if (!nextIds.has(layerId)) removeLayerObject(layerId);
      });
      nextLayers.forEach(loadLayer);
      updateStats();
      if (nextLayers.some((layer) => layer.source || layer.isPreview)) {
        setLoadState((current) => (current.status === "error" ? current : { status: "ready", message: "" }));
      }
    }

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let animationFrame = 0;
    function renderLoop() {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(renderLoop);
    }
    renderLoop();

    sceneApiRef.current = {
      loadLayers,
      resetView: frameScene,
      exportViewport,
      updateOptions(options) {
        currentOptions = { ...options };
        const backgroundColor = options.darkMode ? 0x0d1317 : 0xefefed;
        scene.background = options.transparentBackground ? null : new THREE.Color(backgroundColor);
        renderer.setClearColor(backgroundColor, options.transparentBackground ? 0 : 1);
        grid.visible = options.grid;
        controls.autoRotate = options.autoRotate;
        renderer.toneMappingExposure = options.exposure;
        key.intensity = baseKeyIntensity * options.lightIntensity;
        fill.intensity = baseFillIntensity * options.lightIntensity;
        front.intensity = baseFrontIntensity * options.lightIntensity;
        rim.intensity = baseRimIntensity * options.lightIntensity;
        ambient.intensity = baseAmbientIntensity * options.lightIntensity;
        fabricOverlayMaterial.roughness = options.fabricRoughness;
        fabricOverlayMaterial.metalness = options.fabricMetalness;
        applyTileRepeat();
        fabricOverlayMaterial.needsUpdate = true;
        layerObjects.forEach((record) => {
          const layer = currentLayers.find((item) => item.id === record.object.userData.layerId);
          if (layer) setLayerFabric(record.object, layer.bakeFabric);
        });
      },
      loadFabricTexture(file) {
        const url = URL.createObjectURL(file);
        new THREE.TextureLoader().load(
          url,
          (texture) => {
            applyFabricTexture(createAdjustedFabricTexture(texture));
            layerObjects.forEach((record) => {
              const layer = currentLayers.find((item) => item.id === record.object.userData.layerId);
              if (layer) setLayerFabric(record.object, layer.bakeFabric);
            });
            URL.revokeObjectURL(url);
          },
          undefined,
          () => URL.revokeObjectURL(url),
        );
      },
    };

    resize();
    sceneApiRef.current.updateOptions(viewOptions);
    sceneApiRef.current.loadLayers(layers);
    setSceneReady(true);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
      sceneApiRef.current = null;
      layerObjects.forEach((record) => disposeObject(record.object, sharedMaterials));
      layerObjects.clear();
      fabricOverlayMaterial.map?.dispose();
      fabricOverlayMaterial.dispose();
      studioEnvironment.dispose();
      pmremGenerator.dispose();
      renderer.dispose();
      controls.dispose();
      container.removeChild(renderer.domElement);
      setSceneReady(false);
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function restoreUploads() {
      try {
        const [storedFabric, storedLayers] = await Promise.all([
          readStoredAsset("fabric"),
          Promise.all(
            getStoredLayerMetadata().map(async (layer) => {
              if (!layer.assetKey) return layer;
              const storedAsset = await readStoredAsset(layer.assetKey);
              if (!storedAsset?.blob) return layer;
              return {
                ...layer,
                name: layer.name || storedAsset.name || "Stored layer",
                source: URL.createObjectURL(storedAsset.blob),
                isRemote: false,
                isPreview: false,
              };
            }),
          ),
        ]);

        if (isCancelled) return;

        if (storedLayers.length > 0) {
          setLayers(storedLayers);
          setSelectedLayerId((current) => (storedLayers.some((layer) => layer.id === current) ? current : storedLayers[0].id));
        }

        if (storedFabric?.blob) {
          setFabricTextureName(storedFabric.name || "Stored fabric");
          setFabricTexture({
            blob: storedFabric.blob,
            name: storedFabric.name || "Stored fabric",
          });
        } else {
          const response = await fetch(DEFAULT_FABRIC_URL);
          if (!response.ok) throw new Error(`Default fabric returned ${response.status}`);
          const blob = await response.blob();
          setFabricTextureName(DEFAULT_FABRIC_NAME);
          setFabricTexture({
            blob,
            name: DEFAULT_FABRIC_NAME,
          });
        }
      } catch (error) {
        console.error("Could not restore uploaded files.", error);
      }
    }

    restoreUploads();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    sceneApiRef.current?.updateOptions(viewOptions);
    window.localStorage.setItem(VIEW_OPTIONS_STORAGE_KEY, JSON.stringify(viewOptions));
  }, [viewOptions]);

  useEffect(() => {
    layersRef.current = layers;
    sceneApiRef.current?.loadLayers(layers);
    window.localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(serializeLayers(layers)));
  }, [layers]);

  useEffect(() => {
    if (!sceneReady || !fabricTexture?.blob) return;
    sceneApiRef.current?.loadFabricTexture(fabricTexture.blob);
  }, [fabricTexture, sceneReady]);

  useEffect(() => {
    return () => {
      layersRef.current.forEach((layer) => {
        if (!layer.isRemote && layer.source) URL.revokeObjectURL(layer.source);
      });
    };
  }, []);

  function openLayerUpload(layerId = selectedLayer.id) {
    pendingLayerUploadRef.current = layerId;
    layerFileInputRef.current?.click();
  }

  function handleLayerModelFile(file, layerId = pendingLayerUploadRef.current) {
    if (!file) return;
    const isGlb = file.name.toLowerCase().endsWith(".glb");
    if (!isGlb) {
      setLoadState({ status: "error", message: "Choose a .glb file." });
      return;
    }

    const source = URL.createObjectURL(file);
    const assetKey = makeLayerAssetKey(layerId);
    setLayers((current) =>
      current.map((layer) => {
        if (layer.id !== layerId) return layer;
        if (!layer.isRemote && layer.source) URL.revokeObjectURL(layer.source);
        return {
          ...layer,
          name: file.name.replace(/\.glb$/i, ""),
          source,
          isRemote: false,
          isPreview: false,
          assetKey,
        };
      }),
    );
    setSelectedLayerId(layerId);
    saveStoredAsset(assetKey, file).catch((error) => {
      console.error("Could not save layer upload.", error);
    });
  }

  function handleFabricFile(file) {
    if (!file) return;
    setFabricTextureName(file.name);
    setFabricTexture({ name: file.name, blob: file });
    saveStoredAsset("fabric", file).catch((error) => {
      console.error("Could not save fabric upload.", error);
    });
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.name.toLowerCase().endsWith(".glb"),
    );
    handleLayerModelFile(file, selectedLayer.id);
  }

  function addLayer() {
    const id = makeLayerId();
    const nextLayer = {
      ...DEFAULT_LAYER,
      id,
      name: makeLayerName(layers),
      source: null,
      isRemote: false,
      isPreview: false,
      visible: true,
      bakeFabric: false,
    };
    setLayers((current) => [...current, nextLayer]);
    setSelectedLayerId(id);
  }

  function removeLayer(layerId) {
    setLayers((current) => {
      const layerToRemove = current.find((layer) => layer.id === layerId);
      if (layerToRemove && !layerToRemove.isRemote && layerToRemove.source) {
        URL.revokeObjectURL(layerToRemove.source);
      }
      const nextLayers = current.filter((layer) => layer.id !== layerId);
      if (nextLayers.length === 0) return [{ ...DEFAULT_LAYER }];
      return nextLayers;
    });
    setSelectedLayerId((current) => {
      if (current !== layerId) return current;
      const nextLayer = layers.find((layer) => layer.id !== layerId);
      return nextLayer?.id ?? DEFAULT_LAYER_ID;
    });
  }

  function updateLayer(layerId, updates) {
    setLayers((current) =>
      current.map((layer) => (layer.id === layerId ? { ...layer, ...updates } : layer)),
    );
  }

  function updateOption(key, value) {
    setViewOptions((current) => ({ ...current, [key]: value }));
  }

  function updateTileSize(key, value) {
    const nextValue = clampTileSize(value);
    setViewOptions((current) => ({
      ...current,
      fabricTileWidth: nextValue,
      fabricTileHeight: nextValue,
    }));
    setTileInputs((current) => ({
      ...current,
      fabricTileWidth: formatTileSize(nextValue),
      fabricTileHeight: formatTileSize(nextValue),
    }));
  }

  function handleTileInputChange(key, value) {
    setTileInputs((current) => ({
      ...current,
      fabricTileWidth: value,
      fabricTileHeight: value,
    }));
    if (value === "" || value === "." || value === "-") return;

    const nextValue = Number(value);
    if (Number.isFinite(nextValue)) {
      const linkedValue = clampTileSize(nextValue);
      setViewOptions((current) => ({
        ...current,
        fabricTileWidth: linkedValue,
        fabricTileHeight: linkedValue,
      }));
    }
  }

  function handleTileInputBlur(key) {
    const nextValue = Number(tileInputs[key]);
    updateTileSize(key, Number.isFinite(nextValue) ? nextValue : viewOptions[key]);
  }

  return (
    <main
      className={`app-shell ${viewOptions.darkMode ? "theme-dark" : "theme-light"}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <section className="viewer-stage" aria-label="Layered GLB viewport">
        <div ref={viewportRef} className="viewport" />
        {loadState.status !== "ready" && (
          <div className="status-layer" role="status">
            <div className="status-mark">
              {loadState.status === "error" ? <RotateCcw size={28} /> : <Box size={28} />}
            </div>
            <p>{loadState.status === "error" ? loadState.message : "Loading"}</p>
          </div>
        )}
        {isDragging && (
          <div className="drop-layer">
            <Upload size={34} />
            <span>Release GLB</span>
          </div>
        )}
      </section>

      <aside className="side-panel" aria-label="Viewer controls">
        <div className="brand-row">
          <div>
            <span className="eyebrow">Fabric Bake</span>
            <h1>Layer Viewer</h1>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Toggle color mode"
            title="Toggle color mode"
            onClick={() => updateOption("darkMode", !viewOptions.darkMode)}
          >
            {viewOptions.darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>

        <div className="tab-list" role="tablist" aria-label="Sidebar tabs">
          <button
            className={`tab-button ${activeTab === "layers" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "layers"}
            onClick={() => setActiveTab("layers")}
          >
            <Layers size={16} />
            <span>Layers</span>
          </button>
          <button
            className={`tab-button ${activeTab === "viewer" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "viewer"}
            onClick={() => setActiveTab("viewer")}
          >
            <Grid3X3 size={16} />
            <span>Viewer</span>
          </button>
        </div>

        <input
          ref={layerFileInputRef}
          className="hidden-input"
          type="file"
          accept=".glb,model/gltf-binary"
          onChange={(event) => {
            handleLayerModelFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <input
          ref={textureInputRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          onChange={(event) => {
            handleFabricFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        {activeTab === "layers" && (
          <>
            <div className="model-strip">
              <div className="model-icon">
                <Layers size={22} />
              </div>
              <div className="model-name">
                <span>{selectedLayer.name}</span>
                <small>{selectedLayer.source || selectedLayer.isPreview ? "Selected layer" : "Empty layer"}</small>
              </div>
            </div>

            <div className="button-row">
              <button className="command-button" type="button" onClick={() => openLayerUpload()}>
                <Upload size={17} />
                <span>Open GLB</span>
              </button>
              <button
                className="command-button"
                type="button"
                onClick={() => textureInputRef.current?.click()}
              >
                <ImagePlus size={17} />
                <span>{fabricTextureName || "Fabric"}</span>
              </button>
              <button
                className="icon-button"
                type="button"
                title="Frame layers"
                aria-label="Frame layers"
                onClick={() => sceneApiRef.current?.resetView()}
              >
                <Maximize2 size={18} />
              </button>
            </div>

            <div className="panel-section">
              <div className="section-header">
                <div className="section-title">Layer Stack</div>
                <button className="icon-button compact" type="button" title="Add layer" aria-label="Add layer" onClick={addLayer}>
                  <Plus size={17} />
                </button>
              </div>

              <div className="layer-list">
                {layers.map((layer) => (
                  <div
                    key={layer.id}
                    className={`layer-card ${layer.id === selectedLayer.id ? "selected" : ""}`}
                    onClick={() => setSelectedLayerId(layer.id)}
                  >
                    <div className="layer-card-top">
                      <button
                        className="icon-button compact"
                        type="button"
                        title={layer.visible ? "Hide layer" : "Show layer"}
                        aria-label={layer.visible ? "Hide layer" : "Show layer"}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateLayer(layer.id, { visible: !layer.visible });
                        }}
                      >
                        {layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}
                      </button>
                      <input
                        className="layer-name-input"
                        aria-label="Layer name"
                        value={layer.name}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateLayer(layer.id, { name: event.target.value })}
                      />
                      <button
                        className="icon-button compact"
                        type="button"
                        title="Remove layer"
                        aria-label="Remove layer"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeLayer(layer.id);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>

                    <div className="layer-controls">
                      <button
                        className="command-button slim"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openLayerUpload(layer.id);
                        }}
                      >
                        <Upload size={15} />
                        <span>{layer.source || layer.isPreview ? "Replace GLB" : "Add GLB"}</span>
                      </button>
                      <label className="toggle-chip" onClick={(event) => event.stopPropagation()}>
                        <Check size={15} />
                        <span>Bake fabric</span>
                        <input
                          type="checkbox"
                          checked={layer.bakeFabric}
                          onChange={(event) => updateLayer(layer.id, { bakeFabric: event.target.checked })}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {activeTab === "viewer" && (
          <>
            <div className="button-row">
              <button
                className="icon-button"
                type="button"
                title="Export viewport PNG"
                aria-label="Export viewport PNG"
                onClick={() => sceneApiRef.current?.exportViewport(makeDownloadName(selectedLayer.name))}
              >
                <Download size={18} />
              </button>
              <button
                className="icon-button"
                type="button"
                title="Frame layers"
                aria-label="Frame layers"
                onClick={() => sceneApiRef.current?.resetView()}
              >
                <Maximize2 size={18} />
              </button>
            </div>

            <div className="panel-section">
              <div className="section-title">Display</div>
              <label className="toggle-row">
                <Grid3X3 size={18} />
                <span>Grid</span>
                <input
                  type="checkbox"
                  checked={viewOptions.grid}
                  onChange={(event) => updateOption("grid", event.target.checked)}
                />
              </label>
              <label className="toggle-row">
                <RotateCcw size={18} />
                <span>Rotate</span>
                <input
                  type="checkbox"
                  checked={viewOptions.autoRotate}
                  onChange={(event) => updateOption("autoRotate", event.target.checked)}
                />
              </label>
              <label className="toggle-row">
                <Square size={18} />
                <span>Transparent</span>
                <input
                  type="checkbox"
                  checked={viewOptions.transparentBackground}
                  onChange={(event) => updateOption("transparentBackground", event.target.checked)}
                />
              </label>
              <label className="slider-row with-value">
                <span>Exposure</span>
                <input
                  type="range"
                  min={EXPOSURE_MIN}
                  max={EXPOSURE_MAX}
                  step={EXPOSURE_STEP}
                  value={viewOptions.exposure}
                  onChange={(event) => updateOption("exposure", clampExposure(Number(event.target.value)))}
                />
                <input
                  aria-label="Exposure value"
                  className="numeric-input"
                  type="number"
                  min={EXPOSURE_MIN}
                  max={EXPOSURE_MAX}
                  step={EXPOSURE_STEP}
                  value={formatExposure(viewOptions.exposure)}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (Number.isFinite(nextValue)) updateOption("exposure", clampExposure(nextValue));
                  }}
                />
              </label>
              <label className="slider-row with-value">
                <span>Light</span>
                <input
                  type="range"
                  min={LIGHT_MIN}
                  max={LIGHT_MAX}
                  step={LIGHT_STEP}
                  value={viewOptions.lightIntensity}
                  onChange={(event) =>
                    updateOption("lightIntensity", clampLightIntensity(Number(event.target.value)))
                  }
                />
                <input
                  aria-label="Light value"
                  className="numeric-input"
                  type="number"
                  min={LIGHT_MIN}
                  max={LIGHT_MAX}
                  step={LIGHT_STEP}
                  value={formatLightIntensity(viewOptions.lightIntensity)}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (Number.isFinite(nextValue)) {
                      updateOption("lightIntensity", clampLightIntensity(nextValue));
                    }
                  }}
                />
              </label>
            </div>

            <div className="panel-section">
              <div className="section-title">Fabric</div>
              <button
                className="command-button full"
                type="button"
                onClick={() => textureInputRef.current?.click()}
              >
                <ImagePlus size={17} />
                <span>{fabricTextureName || "Load Texture"}</span>
              </button>
              <label className="toggle-row">
                <Check size={18} />
                <span>Preview</span>
                <input
                  type="checkbox"
                  checked={viewOptions.fabricPreview}
                  onChange={(event) => updateOption("fabricPreview", event.target.checked)}
                />
              </label>
              <label className="toggle-row">
                <Cpu size={18} />
                <span>Browser Bake</span>
                <input
                  type="checkbox"
                  checked={viewOptions.bakeInBrowser}
                  onChange={(event) => updateOption("bakeInBrowser", event.target.checked)}
                />
              </label>
              <label className="slider-row with-value">
                <span>Matte</span>
                <input
                  type="range"
                  min={MATERIAL_MIN}
                  max={MATERIAL_MAX}
                  step={MATERIAL_STEP}
                  value={viewOptions.fabricRoughness}
                  onChange={(event) =>
                    updateOption("fabricRoughness", clampMaterialValue(Number(event.target.value)))
                  }
                />
                <input
                  aria-label="Matte value"
                  className="numeric-input"
                  type="number"
                  min={MATERIAL_MIN}
                  max={MATERIAL_MAX}
                  step={MATERIAL_STEP}
                  value={formatMaterialValue(viewOptions.fabricRoughness)}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (Number.isFinite(nextValue)) {
                      updateOption("fabricRoughness", clampMaterialValue(nextValue));
                    }
                  }}
                />
              </label>
              <label className="slider-row with-value">
                <span>Metal</span>
                <input
                  type="range"
                  min={MATERIAL_MIN}
                  max={MATERIAL_MAX}
                  step={MATERIAL_STEP}
                  value={viewOptions.fabricMetalness}
                  onChange={(event) =>
                    updateOption("fabricMetalness", clampMaterialValue(Number(event.target.value)))
                  }
                />
                <input
                  aria-label="Metalness value"
                  className="numeric-input"
                  type="number"
                  min={MATERIAL_MIN}
                  max={MATERIAL_MAX}
                  step={MATERIAL_STEP}
                  value={formatMaterialValue(viewOptions.fabricMetalness)}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (Number.isFinite(nextValue)) {
                      updateOption("fabricMetalness", clampMaterialValue(nextValue));
                    }
                  }}
                />
              </label>
              <label className="slider-row with-value">
                <span>Tile W</span>
                <input
                  type="range"
                  min={TILE_SIZE_MIN}
                  max={TILE_SIZE_MAX}
                  step={TILE_SIZE_STEP}
                  value={viewOptions.fabricTileWidth}
                  onChange={(event) => updateTileSize("fabricTileWidth", Number(event.target.value))}
                />
                <input
                  aria-label="Tile width"
                  className="numeric-input"
                  type="number"
                  min={TILE_SIZE_MIN}
                  max={TILE_SIZE_MAX}
                  step={TILE_SIZE_STEP}
                  value={tileInputs.fabricTileWidth}
                  onBlur={() => handleTileInputBlur("fabricTileWidth")}
                  onChange={(event) => handleTileInputChange("fabricTileWidth", event.target.value)}
                />
              </label>
              <label className="slider-row with-value">
                <span>Tile H</span>
                <input
                  type="range"
                  min={TILE_SIZE_MIN}
                  max={TILE_SIZE_MAX}
                  step={TILE_SIZE_STEP}
                  value={viewOptions.fabricTileHeight}
                  onChange={(event) => updateTileSize("fabricTileHeight", Number(event.target.value))}
                />
                <input
                  aria-label="Tile height"
                  className="numeric-input"
                  type="number"
                  min={TILE_SIZE_MIN}
                  max={TILE_SIZE_MAX}
                  step={TILE_SIZE_STEP}
                  value={tileInputs.fabricTileHeight}
                  onBlur={() => handleTileInputBlur("fabricTileHeight")}
                  onChange={(event) => handleTileInputChange("fabricTileHeight", event.target.value)}
                />
              </label>
              <div className="tile-readout">
                <Ruler size={18} />
                <span>
                  {fabricRepeat.x.toFixed(1)} x {fabricRepeat.y.toFixed(1)} repeats
                </span>
              </div>
            </div>
          </>
        )}

        <div className="stats-grid" aria-label="Model stats">
          {summaryItems.map(([label, value]) => (
            <div key={label} className="stat-cell">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}

export default App;
