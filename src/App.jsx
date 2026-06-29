import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Download,
  Eye,
  EyeOff,
  FileImage,
  Maximize2,
  Moon,
  Plus,
  RotateCcw,
  Shirt,
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
const NORMAL_STRENGTH_MIN = 0;
const NORMAL_STRENGTH_MAX = 2;
const NORMAL_STRENGTH_STEP = 0.02;
const AUTO_NORMAL_STRENGTH = 0.65;
const MAX_PREVIEW_TEXTURE_SIZE = 2048;
const ASSET_DB_NAME = "fabric-bake-assets";
const ASSET_DB_VERSION = 1;
const ASSET_STORE_NAME = "uploads";
const VIEW_OPTIONS_STORAGE_KEY = "fabric-bake-view-options";
const LAYERS_STORAGE_KEY = "fabric-bake-layers";
const VIEW_OPTIONS_VERSION = 8;
const DEFAULT_LAYER_ID = "preview-layer";
const DEFAULT_FABRIC_NAME = "Default Herringbone";
const DEFAULT_FABRIC_URL = "/local-assets/fabrics/default-herringbone-fabric.png";
const FABRIC_ASSET_KEY = "fabric";
const FABRIC_TEXTURE_SLOTS = ["fabricMap", "map", "normalMap", "roughnessMap", "metalnessMap", "displacementMap"];
const FABRIC_DISPLACEMENT_SCALE = 0.012;
const FABRIC_MAPPING_TILED = "tiled";
const FABRIC_MAPPING_ATLAS = "atlas";
const FABRIC_MAP_LABELS = {
  fabricMap: "Fabric swatch",
  map: "Diffuse",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metalness",
  displacementMap: "Displacement",
};
const FABRIC_MAP_SLOT_ORDER = ["fabricMap", "map", "normalMap", "roughnessMap", "metalnessMap", "displacementMap"];

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
  fabricTileWidth: 0.08,
  fabricTileHeight: 0.08,
  fabricRoughness: 0.9,
  fabricMetalness: 0,
  fabricSheen: 0.16,
  fabricNormalStrength: 0.24,
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

function makeLayerMapAssetKey(layerId, slot) {
  return `layer-map:${layerId}:${slot}`;
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

function clampNormalStrength(value) {
  return Math.min(NORMAL_STRENGTH_MAX, Math.max(NORMAL_STRENGTH_MIN, value));
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

function detectFabricMapSlot(fileName) {
  const normalizedName = fileName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(fabric|swatch|cloth|zoomed out)\b/.test(normalizedName)) return "fabricMap";
  if (/\b(normal|nrm|nor)\b/.test(normalizedName)) return "normalMap";
  if (/\b(roughness|rough|rgh)\b/.test(normalizedName)) return "roughnessMap";
  if (/\b(metalness|metallic|metal)\b/.test(normalizedName)) return "metalnessMap";
  if (/\b(displacement|height|disp)\b/.test(normalizedName)) return "displacementMap";
  if (/\b(diffuse|albedo|basecolor|base color|color|colour)\b/.test(normalizedName)) return "map";
  return null;
}

function isImageFile(file) {
  return file?.type?.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file?.name ?? "");
}

function getFabricSetLabel(fabricSet) {
  const maps = fabricSet?.maps ?? {};
  const mapCount = Object.values(maps).filter(Boolean).length;
  const baseName = maps.map?.name ?? fabricSet?.name ?? "Texture set";
  if (mapCount <= 1) return baseName;
  return `${baseName} + ${mapCount - 1}`;
}

function hasFabricMap(fabricSet, slot) {
  return Boolean(fabricSet?.maps?.[slot]);
}

function makeFabricSetFromFiles(fileList) {
  const files = Array.from(fileList ?? []).filter(isImageFile);
  if (files.length === 0) return null;

  const maps = {};
  files.forEach((file) => {
    const detectedSlot = files.length === 1 ? "map" : detectFabricMapSlot(file.name);
    const slot = detectedSlot ?? (!maps.map ? "map" : null);
    if (!slot || maps[slot]) return;
    maps[slot] = {
      blob: file,
      name: file.name,
    };
  });

  if (!Object.values(maps).some(Boolean)) return null;
  return {
    mapping: files.length > 1 ? FABRIC_MAPPING_ATLAS : FABRIC_MAPPING_TILED,
    name: getFabricSetLabel({ maps }),
    maps,
  };
}

function normalizeStoredFabricSet(record) {
  if (!record) return null;
  if (record.maps) {
    const maps = {};
    FABRIC_TEXTURE_SLOTS.forEach((slot) => {
      const mapRecord = record.maps[slot];
      if (!mapRecord?.blob) return;
      maps[slot] = {
        blob: mapRecord.blob,
        name: mapRecord.name || "Stored texture",
      };
    });
    if (!Object.values(maps).some(Boolean)) return null;
    return {
      mapping: record.mapping || FABRIC_MAPPING_ATLAS,
      name: record.name || getFabricSetLabel({ maps }),
      maps,
    };
  }
  if (record.blob) {
    return {
      mapping: FABRIC_MAPPING_TILED,
      name: record.name || "Stored fabric",
      maps: {
        map: {
          blob: record.blob,
          name: record.name || "Stored fabric",
        },
      },
    };
  }
  return null;
}

function normalizeLayerFabricSet(fabricSet) {
  if (!fabricSet?.maps) return null;
  const maps = {};
  FABRIC_TEXTURE_SLOTS.forEach((slot) => {
    const map = fabricSet.maps[slot];
    if (!map) return;
    maps[slot] = {
      blob: map.blob,
      name: map.name || FABRIC_MAP_LABELS[slot],
      assetKey: map.assetKey,
    };
  });
  if (!Object.values(maps).some(Boolean)) return null;
  return {
    mapping: fabricSet.mapping || FABRIC_MAPPING_ATLAS,
    name: fabricSet.name || getFabricSetLabel({ maps }),
    maps,
  };
}

function serializeFabricSet(fabricSet) {
  const normalizedSet = normalizeLayerFabricSet(fabricSet);
  if (!normalizedSet) return null;
  const maps = {};
  FABRIC_TEXTURE_SLOTS.forEach((slot) => {
    const map = normalizedSet.maps[slot];
    if (!map) return;
    maps[slot] = {
      name: map.name,
      assetKey: map.assetKey,
    };
  });
  return {
    mapping: normalizedSet.mapping,
    name: normalizedSet.name,
    maps,
  };
}

function normalizeViewOptions(options = {}) {
  return {
    ...DEFAULT_VIEW_OPTIONS,
    ...options,
    viewPresetVersion: VIEW_OPTIONS_VERSION,
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
    fabricSheen: Number.isFinite(Number(options.fabricSheen))
      ? clampMaterialValue(Number(options.fabricSheen))
      : DEFAULT_VIEW_OPTIONS.fabricSheen,
    fabricNormalStrength: Number.isFinite(Number(options.fabricNormalStrength))
      ? clampNormalStrength(Number(options.fabricNormalStrength))
      : DEFAULT_VIEW_OPTIONS.fabricNormalStrength,
  };
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
    fabricSet: normalizeLayerFabricSet(layer?.fabricSet),
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
  return layers.map(({ id, name, isRemote, isPreview, assetKey, fabricSet, visible, bakeFabric }) => ({
    id,
    name,
    isRemote,
    isPreview,
    assetKey,
    fabricSet: serializeFabricSet(fabricSet),
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

async function saveStoredFabricSet(fabricSet) {
  const db = await openAssetDb();
  const maps = {};
  FABRIC_TEXTURE_SLOTS.forEach((slot) => {
    const map = fabricSet.maps?.[slot];
    if (!map?.blob) return;
    maps[slot] = {
      blob: map.blob,
      name: map.name,
      type: map.blob.type,
      lastModified: map.blob.lastModified,
    };
  });

  const record = {
    mapping: fabricSet.mapping || FABRIC_MAPPING_TILED,
    name: fabricSet.name || getFabricSetLabel(fabricSet),
    maps,
    savedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ASSET_STORE_NAME, "readwrite");
    const request = transaction.objectStore(ASSET_STORE_NAME).put(record, FABRIC_ASSET_KEY);
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

function disposeObject(root, materialSkipSet = new Set(), textureSkipSet = new Set()) {
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
        if (value?.isTexture && !textureSkipSet.has(value.uuid)) value.dispose();
      });
      material.dispose();
    });
  });
}

function App() {
  const viewportRef = useRef(null);
  const layerFileInputRef = useRef(null);
  const mapSlotInputRef = useRef(null);
  const sceneApiRef = useRef(null);
  const pendingLayerUploadRef = useRef(DEFAULT_LAYER_ID);
  const pendingMapSlotRef = useRef("map");
  const layersRef = useRef([]);
  const [sceneReady, setSceneReady] = useState(false);
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
  const [editingLayerId, setEditingLayerId] = useState(null);

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
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = viewOptions.exposure;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    container.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const studioEnvironment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = studioEnvironment;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.autoRotateSpeed = 1.2;
    controls.addEventListener("change", invalidate);

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

    const fabricOverlayMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: viewOptions.fabricRoughness,
      metalness: viewOptions.fabricMetalness,
      sheen: viewOptions.fabricSheen,
      sheenColor: new THREE.Color(0xffffff),
      sheenRoughness: 0.86,
      normalScale: new THREE.Vector2(0.24, 0.24),
      anisotropy: 0.38,
      anisotropyRotation: Math.PI / 2,
      specularIntensity: 0.16,
      specularColor: new THREE.Color(0xffffff),
      envMapIntensity: 0.06,
      displacementScale: 0,
      transparent: false,
      opacity: 1,
    });
    const sharedMaterials = new Set([fabricOverlayMaterial.uuid]);
    const sharedTextureIds = new Set();
    const layerObjects = new Map();
    const layerTextureSets = new Map();
    const loadTickets = new Map();
    const fabricBox = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    const fabricBounds = new THREE.Vector3(1, 1, 1);
    let currentOptions = { ...viewOptions };
    let currentLayers = layers;
    let currentFabricMapping = FABRIC_MAPPING_TILED;
    let currentFabricMaps = {};
    let needsRender = true;

    function invalidate() {
      needsRender = true;
    }

    function resize() {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      invalidate();
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
      fabricBox.copy(box);
      fabricBounds.copy(size);
      applyTileRepeat();
      setModelStats({
        ...getMeshStats(modelRoot),
        size,
      });
      invalidate();
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
      fabricBox.copy(box);
      fabricBounds.copy(size);
      applyTileRepeat();
      updateStats();
      invalidate();
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

    function getFabricTextures() {
      const textures = FABRIC_TEXTURE_SLOTS.map((slot) => currentFabricMaps[slot]).filter(Boolean);
      layerTextureSets.forEach((textureSet) => {
        FABRIC_TEXTURE_SLOTS.forEach((slot) => {
          if (textureSet.maps?.[slot]) textures.push(textureSet.maps[slot]);
        });
      });
      return textures;
    }

    function applyTileRepeat() {
      const repeat = getTileRepeat();
      getFabricTextures().forEach((texture) => {
        if (texture.userData.fabricMapping === FABRIC_MAPPING_TILED) {
          texture.repeat.set(repeat.x, repeat.y);
        } else {
          texture.repeat.set(1, 1);
        }
        texture.offset.set(0, 0);
        texture.needsUpdate = true;
      });
    }

    function limitTexturePreviewSize(texture) {
      const image = texture.image;
      const width = image?.naturalWidth || image?.videoWidth || image?.width;
      const height = image?.naturalHeight || image?.videoHeight || image?.height;
      if (!image || !width || !height) return texture;
      const maxDimension = Math.max(width, height);
      if (maxDimension <= MAX_PREVIEW_TEXTURE_SIZE) return texture;

      const scale = MAX_PREVIEW_TEXTURE_SIZE / maxDimension;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return texture;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.image = canvas;
      return texture;
    }

    function prepareFabricTexture(
      texture,
      { colorSpace = THREE.NoColorSpace, mapping = currentFabricMapping } = {},
    ) {
      limitTexturePreviewSize(texture);
      texture.colorSpace = colorSpace;
      texture.wrapS = mapping === FABRIC_MAPPING_ATLAS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      texture.wrapT = mapping === FABRIC_MAPPING_ATLAS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      texture.flipY = mapping !== FABRIC_MAPPING_ATLAS;
      texture.userData.fabricMapping = mapping;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      return texture;
    }

    function refreshFabricLayers() {
      layerObjects.forEach((record) => {
        const layer = currentLayers.find((item) => item.id === record.object.userData.layerId);
        if (layer) setLayerFabric(record.object, layer.bakeFabric);
      });
    }

    function applyFabricMap(slot, texture, options) {
      const nextTexture = prepareFabricTexture(texture, options);
      if (fabricOverlayMaterial[slot]) fabricOverlayMaterial[slot].dispose();
      fabricOverlayMaterial[slot] = nextTexture;
      currentFabricMaps[slot] = nextTexture;
      sharedTextureIds.add(nextTexture.uuid);
      applyTileRepeat();
      fabricOverlayMaterial.needsUpdate = true;
      invalidate();
    }

    function clearFabricMaps() {
      FABRIC_TEXTURE_SLOTS.forEach((slot) => {
        if (!fabricOverlayMaterial[slot]) return;
        sharedTextureIds.delete(fabricOverlayMaterial[slot].uuid);
        fabricOverlayMaterial[slot].dispose();
        fabricOverlayMaterial[slot] = null;
      });
      currentFabricMaps = {};
      fabricOverlayMaterial.displacementScale = 0;
      fabricOverlayMaterial.needsUpdate = true;
      invalidate();
    }

    function clearLayerTextureSet(layerId) {
      const textureSet = layerTextureSets.get(layerId);
      if (!textureSet) return;
      FABRIC_TEXTURE_SLOTS.forEach((slot) => {
        const texture = textureSet.maps?.[slot];
        if (!texture) return;
        sharedTextureIds.delete(texture.uuid);
        texture.dispose();
      });
      if (textureSet.fabricSafeRoughnessMap) {
        sharedTextureIds.delete(textureSet.fabricSafeRoughnessMap.uuid);
        textureSet.fabricSafeRoughnessMap.dispose();
      }
      layerTextureSets.delete(layerId);
    }

    function setLayerTexture(layerId, slot, texture, options) {
      const textureSet = layerTextureSets.get(layerId) ?? {
        mapping: options?.mapping || FABRIC_MAPPING_ATLAS,
        maps: {},
      };
      const nextTexture = prepareFabricTexture(texture, options);
      if (textureSet.maps[slot]) {
        sharedTextureIds.delete(textureSet.maps[slot].uuid);
        textureSet.maps[slot].dispose();
      }
      textureSet.mapping = options?.mapping || textureSet.mapping;
      textureSet.maps[slot] = nextTexture;
      sharedTextureIds.add(nextTexture.uuid);
      layerTextureSets.set(layerId, textureSet);
      applyTileRepeat();
      invalidate();
      return textureSet;
    }

    function getLayerTextureSet(layerId) {
      return layerTextureSets.get(layerId) ?? {
        mapping: currentFabricMapping,
        maps: currentFabricMaps,
      };
    }

    function hasTextureMaps(textureSet) {
      return Object.values(textureSet?.maps ?? {}).some(Boolean);
    }

    function getTextureImageSize(texture) {
      const image = texture.image;
      return {
        image,
        width: image?.naturalWidth || image?.videoWidth || image?.width,
        height: image?.naturalHeight || image?.videoHeight || image?.height,
      };
    }

    function createCanvasFromTexture(texture) {
      const { image, width, height } = getTextureImageSize(texture);
      if (!image || !width || !height) return null;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;

      context.drawImage(image, 0, 0, width, height);
      return { canvas, context, width, height };
    }

    function createAutomaticNormalMap(sourceTexture) {
      const source = createCanvasFromTexture(sourceTexture);
      if (!source) return null;

      const { context, width, height } = source;
      const sourcePixels = context.getImageData(0, 0, width, height).data;
      const heightField = new Float32Array(width * height);

      for (let index = 0; index < heightField.length; index += 1) {
        const pixelIndex = index * 4;
        heightField[index] =
          (sourcePixels[pixelIndex] * 0.2126 +
            sourcePixels[pixelIndex + 1] * 0.7152 +
            sourcePixels[pixelIndex + 2] * 0.0722) /
          255;
      }

      const normalCanvas = document.createElement("canvas");
      normalCanvas.width = width;
      normalCanvas.height = height;
      const normalContext = normalCanvas.getContext("2d");
      if (!normalContext) return null;

      const normalImage = normalContext.createImageData(width, height);
      const normalPixels = normalImage.data;
      const sampleHeight = (x, y) => heightField[((y + height) % height) * width + ((x + width) % width)];

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const dx = (sampleHeight(x - 1, y) - sampleHeight(x + 1, y)) * AUTO_NORMAL_STRENGTH;
          const dy = (sampleHeight(x, y - 1) - sampleHeight(x, y + 1)) * AUTO_NORMAL_STRENGTH;
          const invLength = 1 / Math.hypot(dx, dy, 1);
          const pixelIndex = (y * width + x) * 4;

          normalPixels[pixelIndex] = Math.round((dx * invLength * 0.5 + 0.5) * 255);
          normalPixels[pixelIndex + 1] = Math.round((dy * invLength * 0.5 + 0.5) * 255);
          normalPixels[pixelIndex + 2] = Math.round((invLength * 0.5 + 0.5) * 255);
          normalPixels[pixelIndex + 3] = 255;
        }
      }

      normalContext.putImageData(normalImage, 0, 0);
      return new THREE.CanvasTexture(normalCanvas);
    }

    function createAutomaticRoughnessMap(sourceTexture) {
      const source = createCanvasFromTexture(sourceTexture);
      if (!source) return null;

      const { canvas, context, width, height } = source;
      const imageData = context.getImageData(0, 0, width, height);
      const { data } = imageData;

      for (let index = 0; index < data.length; index += 4) {
        const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
        const roughness = Math.round((0.82 + (1 - luminance) * 0.16) * 255);
        data[index] = roughness;
        data[index + 1] = roughness;
        data[index + 2] = roughness;
        data[index + 3] = 255;
      }

      context.putImageData(imageData, 0, 0);
      return new THREE.CanvasTexture(canvas);
    }

    function createFabricSafeRoughnessMap(sourceTexture) {
      const source = createCanvasFromTexture(sourceTexture);
      if (!source) return null;

      const { canvas, context, width, height } = source;
      const imageData = context.getImageData(0, 0, width, height);
      const { data } = imageData;

      for (let index = 0; index < data.length; index += 4) {
        const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
        const roughness = Math.round((0.82 + luminance * 0.18) * 255);
        data[index] = roughness;
        data[index + 1] = roughness;
        data[index + 2] = roughness;
        data[index + 3] = 255;
      }

      context.putImageData(imageData, 0, 0);
      return prepareFabricTexture(new THREE.CanvasTexture(canvas), {
        colorSpace: THREE.NoColorSpace,
        mapping: FABRIC_MAPPING_ATLAS,
      });
    }

    function getFabricRoughnessTexture(textureSet) {
      if (!textureSet.maps?.roughnessMap) return null;
      if (!textureSet.fabricSafeRoughnessMap) {
        textureSet.fabricSafeRoughnessMap = createFabricSafeRoughnessMap(textureSet.maps.roughnessMap);
        if (textureSet.fabricSafeRoughnessMap) sharedTextureIds.add(textureSet.fabricSafeRoughnessMap.uuid);
      }
      return textureSet.fabricSafeRoughnessMap;
    }

    function applyGeneratedFabricUv(node) {
      const geometry = node.geometry;
      const position = geometry?.getAttribute("position");
      if (!geometry || !position) return;
      if (geometry.getAttribute("uv")) return;

      if (!("originalUv" in node.userData)) {
        node.userData.originalUv = geometry.getAttribute("uv") ?? null;
      }
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();

      const normal = geometry.getAttribute("normal");
      const uv = new Float32Array(position.count * 2);
      const boundsSize = fabricBox.getSize(new THREE.Vector3());
      const boundsMin = fabricBox.min;
      const worldPosition = new THREE.Vector3();
      const worldNormal = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(node.matrixWorld);
      const horizontalSpan = Math.max(boundsSize.x, boundsSize.z, TILE_SIZE_MIN);
      const verticalSpan = Math.max(boundsSize.y, TILE_SIZE_MIN);

      for (let index = 0; index < position.count; index += 1) {
        worldPosition.fromBufferAttribute(position, index).applyMatrix4(node.matrixWorld);
        worldNormal.fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize();

        if (Math.abs(worldNormal.y) > Math.abs(worldNormal.x) && Math.abs(worldNormal.y) > Math.abs(worldNormal.z)) {
          uv[index * 2] = (worldPosition.x - boundsMin.x) / horizontalSpan;
          uv[index * 2 + 1] = (worldPosition.z - boundsMin.z) / horizontalSpan;
        } else if (Math.abs(worldNormal.x) > Math.abs(worldNormal.z)) {
          uv[index * 2] = (worldPosition.z - boundsMin.z) / horizontalSpan;
          uv[index * 2 + 1] = (worldPosition.y - boundsMin.y) / verticalSpan;
        } else {
          uv[index * 2] = (worldPosition.x - boundsMin.x) / horizontalSpan;
          uv[index * 2 + 1] = (worldPosition.y - boundsMin.y) / verticalSpan;
        }
      }

      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }

    function restoreOriginalUv(node) {
      if (!node.geometry || !("originalUv" in node.userData)) return;
      if (node.userData.originalUv) {
        node.geometry.setAttribute("uv", node.userData.originalUv);
      } else {
        node.geometry.deleteAttribute("uv");
      }
    }

    function getMaterialArray(material) {
      return Array.isArray(material) ? material.filter(Boolean) : material ? [material] : [];
    }

    function disposeMaterialOnly(material) {
      getMaterialArray(material).forEach((item) => {
        if (sharedMaterials.has(item.uuid)) return;
        Object.values(item).forEach((value) => {
          if (value?.isTexture && !sharedTextureIds.has(value.uuid)) value.dispose();
        });
        item.dispose();
      });
    }

    function clearNodeAtlasMaterial(node) {
      if (!node.userData.fabricAtlasMaterial) return;
      disposeMaterialOnly(node.userData.fabricAtlasMaterial);
      delete node.userData.fabricAtlasMaterial;
    }

    function createMappedMaterial(sourceMaterial, textureSet = getLayerTextureSet()) {
      const maps = textureSet.maps ?? {};
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: maps.roughnessMap ? 1 : Math.max(currentOptions.fabricRoughness, 0.82),
        metalness: maps.metalnessMap ? 1 : 0,
        envMapIntensity: 0,
      });
      if (sourceMaterial?.side !== undefined) material.side = sourceMaterial.side;
      if (sourceMaterial?.alphaTest !== undefined) material.alphaTest = sourceMaterial.alphaTest;
      if (sourceMaterial?.transparent !== undefined) material.transparent = sourceMaterial.transparent;
      if (sourceMaterial?.opacity !== undefined) material.opacity = sourceMaterial.opacity;
      material.name = sourceMaterial?.name ? `${sourceMaterial.name} Fabric` : "Fabric material";

      if (maps.fabricMap) material.map = maps.fabricMap;
      else if (maps.map) material.map = maps.map;
      if (maps.normalMap) {
        material.normalMap = maps.normalMap;
        material.normalScale?.set(1, 1);
      }
      if (maps.roughnessMap) material.roughnessMap = maps.roughnessMap;
      if (maps.metalnessMap) material.metalnessMap = maps.metalnessMap;
      if (maps.displacementMap) {
        material.displacementMap = maps.displacementMap;
        material.displacementScale = 0;
      }
      material.needsUpdate = true;
      return material;
    }

    function applyAtlasMapsToNode(node, textureSet) {
      clearNodeAtlasMaterial(node);
      const originalMaterial = node.userData.originalMaterial ?? node.material;
      const mappedMaterial = Array.isArray(originalMaterial)
        ? originalMaterial.map((material) => createMappedMaterial(material, textureSet))
        : createMappedMaterial(originalMaterial, textureSet);
      node.userData.fabricAtlasMaterial = mappedMaterial;
      node.material = mappedMaterial;
    }

    function setLayerFabric(object, enabled) {
      object.updateWorldMatrix(true, true);
      object.traverse((node) => {
        if (!node.isMesh) return;
        if (enabled && currentOptions.fabricPreview) {
          const textureSet = getLayerTextureSet(object.userData.layerId);
          node.userData.originalMaterial ??= node.material;
          if (hasTextureMaps(textureSet)) {
            clearNodeAtlasMaterial(node);
            restoreOriginalUv(node);
            applyAtlasMapsToNode(node, textureSet);
          } else {
            clearNodeAtlasMaterial(node);
            applyGeneratedFabricUv(node);
            node.material = fabricOverlayMaterial;
          }
        } else if (node.userData.originalMaterial) {
          clearNodeAtlasMaterial(node);
          node.material = node.userData.originalMaterial;
          restoreOriginalUv(node);
        }
      });
    }

    function removeLayerObject(layerId) {
      const record = layerObjects.get(layerId);
      if (!record) return;
      modelRoot.remove(record.object);
      disposeObject(record.object, sharedMaterials, sharedTextureIds);
      clearLayerTextureSet(layerId);
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
      frameScene();
      setLayerFabric(object, layer.bakeFabric);
      updateStats();
      invalidate();
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
            disposeObject(gltf.scene, sharedMaterials, sharedTextureIds);
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
      if (controls.autoRotate) {
        controls.update();
        needsRender = true;
      }
      if (needsRender) {
        renderer.render(scene, camera);
        needsRender = false;
      }
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
        fabricOverlayMaterial.roughness = currentFabricMaps.roughnessMap ? 1 : options.fabricRoughness;
        fabricOverlayMaterial.metalness = currentFabricMaps.metalnessMap ? 1 : options.fabricMetalness;
        fabricOverlayMaterial.sheen = options.fabricSheen;
        const normalStrength = currentFabricMaps.normalMap ? 1 : options.fabricNormalStrength;
        fabricOverlayMaterial.normalScale.set(normalStrength, normalStrength);
        applyTileRepeat();
        fabricOverlayMaterial.needsUpdate = true;
        layerObjects.forEach((record) => {
          const layer = currentLayers.find((item) => item.id === record.object.userData.layerId);
          if (layer) setLayerFabric(record.object, layer.bakeFabric);
        });
        invalidate();
      },
      loadLayerFabricTextureSet(layerId, fabricSet) {
        const loader = new THREE.TextureLoader();
        const maps = fabricSet?.maps ?? {};
        const entries = FABRIC_TEXTURE_SLOTS.map((slot) => [slot, maps[slot]?.blob]).filter(([, blob]) => blob);
        const mapping = fabricSet?.mapping || FABRIC_MAPPING_ATLAS;

        if (entries.length === 0) {
          clearLayerTextureSet(layerId);
          refreshFabricLayers();
          return;
        }

        Promise.all(
          entries.map(
            ([slot, blob]) =>
              new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                loader.load(
                  url,
                  (texture) => {
                    URL.revokeObjectURL(url);
                    resolve([slot, texture]);
                  },
                  undefined,
                  (error) => {
                    URL.revokeObjectURL(url);
                    reject(error);
                  },
                );
              }),
          ),
        )
          .then((loadedEntries) => {
            clearLayerTextureSet(layerId);
            loadedEntries.forEach(([slot, texture]) => {
              setLayerTexture(layerId, slot, texture, {
                colorSpace: slot === "map" || slot === "fabricMap" ? THREE.SRGBColorSpace : THREE.NoColorSpace,
                mapping: slot === "fabricMap" ? FABRIC_MAPPING_TILED : mapping,
              });
            });
            const record = layerObjects.get(layerId);
            const layer = currentLayers.find((item) => item.id === layerId);
            if (record && layer) setLayerFabric(record.object, layer.bakeFabric);
            updateStats();
            invalidate();
          })
          .catch((error) => {
            console.error("Could not load layer texture set.", error);
          });
      },
      loadFabricTextureSet(fabricSet) {
        const loader = new THREE.TextureLoader();
        const maps = fabricSet?.maps ?? {};
        const entries = FABRIC_TEXTURE_SLOTS.map((slot) => [slot, maps[slot]?.blob]).filter(([, blob]) => blob);
        const mapping = fabricSet?.mapping || FABRIC_MAPPING_TILED;

        if (entries.length === 0) return;

        Promise.all(
          entries.map(
            ([slot, blob]) =>
              new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                loader.load(
                  url,
                  (texture) => {
                    URL.revokeObjectURL(url);
                    resolve([slot, texture]);
                  },
                  undefined,
                  (error) => {
                    URL.revokeObjectURL(url);
                    reject(error);
                  },
                );
              }),
          ),
        )
          .then((loadedEntries) => {
            currentFabricMapping = mapping;
            const loadedTextures = Object.fromEntries(loadedEntries);
            const sourceTexture = loadedTextures.map;
            const shouldGenerateMaps = mapping !== FABRIC_MAPPING_ATLAS;
            const automaticNormalMap = shouldGenerateMaps && sourceTexture && !loadedTextures.normalMap
              ? createAutomaticNormalMap(sourceTexture)
              : null;
            const automaticRoughnessMap = shouldGenerateMaps && sourceTexture && !loadedTextures.roughnessMap
              ? createAutomaticRoughnessMap(sourceTexture)
              : null;

            clearFabricMaps();
            if (loadedTextures.map) {
              applyFabricMap("map", loadedTextures.map, { colorSpace: THREE.SRGBColorSpace, mapping });
            } else if (loadedTextures.fabricMap) {
              applyFabricMap("map", loadedTextures.fabricMap, {
                colorSpace: THREE.SRGBColorSpace,
                mapping: FABRIC_MAPPING_TILED,
              });
            }
            if (loadedTextures.normalMap) applyFabricMap("normalMap", loadedTextures.normalMap, { mapping });
            if (loadedTextures.roughnessMap) applyFabricMap("roughnessMap", loadedTextures.roughnessMap, { mapping });
            if (loadedTextures.metalnessMap) applyFabricMap("metalnessMap", loadedTextures.metalnessMap, { mapping });
            if (loadedTextures.displacementMap) {
              applyFabricMap("displacementMap", loadedTextures.displacementMap, { mapping });
              fabricOverlayMaterial.displacementScale = FABRIC_DISPLACEMENT_SCALE;
            }
            if (automaticNormalMap) applyFabricMap("normalMap", automaticNormalMap, { mapping });
            if (automaticRoughnessMap) applyFabricMap("roughnessMap", automaticRoughnessMap, { mapping });
            refreshFabricLayers();
          })
          .catch((error) => {
            console.error("Could not load fabric texture set.", error);
          });
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
      layerObjects.forEach((record) => disposeObject(record.object, sharedMaterials, sharedTextureIds));
      layerObjects.clear();
      fabricOverlayMaterial.map?.dispose();
      fabricOverlayMaterial.normalMap?.dispose();
      fabricOverlayMaterial.roughnessMap?.dispose();
      fabricOverlayMaterial.metalnessMap?.dispose();
      fabricOverlayMaterial.displacementMap?.dispose();
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
          readStoredAsset(FABRIC_ASSET_KEY),
          Promise.all(
            getStoredLayerMetadata().map(async (layer) => {
              let nextLayer = { ...layer };
              if (layer.assetKey) {
                const storedAsset = await readStoredAsset(layer.assetKey);
                if (storedAsset?.blob) {
                  nextLayer = {
                    ...nextLayer,
                    name: layer.name || storedAsset.name || "Stored layer",
                    source: URL.createObjectURL(storedAsset.blob),
                    isRemote: false,
                    isPreview: false,
                  };
                }
              }

              const restoredFabricSet = normalizeLayerFabricSet(layer.fabricSet);
              if (restoredFabricSet?.maps) {
                const maps = {};
                await Promise.all(
                  FABRIC_TEXTURE_SLOTS.map(async (slot) => {
                    const map = restoredFabricSet.maps[slot];
                    if (!map?.assetKey) return;
                    const storedMap = await readStoredAsset(map.assetKey);
                    if (!storedMap?.blob) return;
                    maps[slot] = {
                      blob: storedMap.blob,
                      name: map.name || storedMap.name || FABRIC_MAP_LABELS[slot],
                      assetKey: map.assetKey,
                    };
                  }),
                );
                if (Object.values(maps).some(Boolean)) {
                  nextLayer = {
                    ...nextLayer,
                    fabricSet: {
                      mapping: restoredFabricSet.mapping,
                      name: getFabricSetLabel({ maps }),
                      maps,
                    },
                  };
                }
              }

              return nextLayer;
            }),
          ),
        ]);

        if (isCancelled) return;

        if (storedLayers.length > 0) {
          setLayers(storedLayers);
          setSelectedLayerId((current) => (storedLayers.some((layer) => layer.id === current) ? current : storedLayers[0].id));
        }

        const storedFabricSet = normalizeStoredFabricSet(storedFabric);
        if (storedFabricSet) {
          setFabricTextureName(getFabricSetLabel(storedFabricSet));
          setFabricTexture(storedFabricSet);
        } else {
          const response = await fetch(DEFAULT_FABRIC_URL);
          if (!response.ok) throw new Error(`Default fabric returned ${response.status}`);
          const blob = await response.blob();
          const defaultFabricSet = {
            mapping: FABRIC_MAPPING_TILED,
            name: DEFAULT_FABRIC_NAME,
            maps: {
              map: {
                blob,
                name: DEFAULT_FABRIC_NAME,
              },
            },
          };
          setFabricTextureName(DEFAULT_FABRIC_NAME);
          setFabricTexture(defaultFabricSet);
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
    layers.forEach((layer) => {
      sceneApiRef.current?.loadLayerFabricTextureSet(layer.id, layer.fabricSet);
    });
    window.localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(serializeLayers(layers)));
  }, [layers]);

  useEffect(() => {
    if (!sceneReady || !fabricTexture?.maps) return;
    sceneApiRef.current?.loadFabricTextureSet(fabricTexture);
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
          bakeFabric: false,
        };
      }),
    );
    setSelectedLayerId(layerId);
    saveStoredAsset(assetKey, file).catch((error) => {
      console.error("Could not save layer upload.", error);
    });
  }

  function handleLayerModelFiles(fileList, layerId = pendingLayerUploadRef.current) {
    const files = Array.from(fileList ?? []).filter((file) => file.name.toLowerCase().endsWith(".glb"));
    if (files.length === 0) {
      setLoadState({ status: "error", message: "Choose .glb files." });
      return;
    }
    if (files.length === 1) {
      handleLayerModelFile(files[0], layerId);
      return;
    }

    const targetLayerId = layerId;
    const nextLayers = files.map((file, index) => {
      const id = index === 0 ? targetLayerId : makeLayerId();
      const source = URL.createObjectURL(file);
      const assetKey = makeLayerAssetKey(id);
      saveStoredAsset(assetKey, file).catch((error) => {
        console.error("Could not save layer upload.", error);
      });
      return {
        ...DEFAULT_LAYER,
        id,
        name: file.name.replace(/\.glb$/i, ""),
        source,
        isRemote: false,
        isPreview: false,
        assetKey,
        visible: true,
        bakeFabric: false,
      };
    });

    setLayers((current) => {
      const targetIndex = current.findIndex((layer) => layer.id === targetLayerId);
      const insertIndex = targetIndex >= 0 ? targetIndex : current.length;
      const targetLayer = current[targetIndex];
      if (targetLayer && !targetLayer.isRemote && targetLayer.source) URL.revokeObjectURL(targetLayer.source);
      return [
        ...current.slice(0, insertIndex),
        ...nextLayers,
        ...current.slice(insertIndex + (targetIndex >= 0 ? 1 : 0)),
      ];
    });
    setSelectedLayerId(targetLayerId);
  }

  function openMapSlotUpload(slot) {
    pendingMapSlotRef.current = slot;
    mapSlotInputRef.current?.click();
  }

  function handleLayerMapFile(slot, file, layerId = selectedLayerId) {
    if (!slot || !file || !isImageFile(file)) return;
    const assetKey = makeLayerMapAssetKey(layerId, slot);
    setLayers((current) =>
      current.map((layer) => {
        if (layer.id !== layerId) return layer;
        const currentFabricSet = normalizeLayerFabricSet(layer.fabricSet) ?? {
          mapping: FABRIC_MAPPING_ATLAS,
          name: "Layer maps",
          maps: {},
        };
        const maps = {
          ...currentFabricSet.maps,
          [slot]: {
            blob: file,
            name: file.name,
            assetKey,
          },
        };
        return {
          ...layer,
          bakeFabric: true,
          fabricSet: {
            mapping: FABRIC_MAPPING_ATLAS,
            name: getFabricSetLabel({ maps }),
            maps,
          },
        };
      }),
    );
    saveStoredAsset(assetKey, file).catch((error) => {
      console.error("Could not save layer map upload.", error);
    });
  }

  function handleMapSlotDrop(event, slot) {
    event.preventDefault();
    event.stopPropagation();
    const file = Array.from(event.dataTransfer.files).find(isImageFile);
    handleLayerMapFile(slot, file);
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const modelFiles = files.filter((item) => item.name.toLowerCase().endsWith(".glb"));
    if (modelFiles.length > 0) {
      handleLayerModelFiles(modelFiles, selectedLayer.id);
    }
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
    setEditingLayerId((current) => (current === layerId ? null : current));
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
  const selectedHasModel = Boolean(selectedLayer.source || selectedLayer.isPreview);
  const selectedFabricSet = selectedLayer.fabricSet ?? fabricTexture;
  const hasFabricSwatch = hasFabricMap(selectedFabricSet, "fabricMap");
  const isFabricAtlas = selectedFabricSet?.mapping === FABRIC_MAPPING_ATLAS;
  const isTileDisabled = isFabricAtlas && !hasFabricSwatch;
  const hasRoughnessMap = hasFabricMap(selectedFabricSet, "roughnessMap");
  const hasNormalMap = hasFabricMap(selectedFabricSet, "normalMap");
  const hasMetalnessMap = hasFabricMap(selectedFabricSet, "metalnessMap");

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
              {loadState.status === "error" ? <RotateCcw size={26} /> : <Box size={26} />}
            </div>
            <p>{loadState.status === "error" ? loadState.message : "Loading"}</p>
          </div>
        )}
        {isDragging && (
          <div className="drop-layer">
            <Upload size={34} />
            <span>Release to add</span>
          </div>
        )}
      </section>

      <aside className="side-panel" aria-label="Viewer controls">
        <input
          ref={layerFileInputRef}
          className="hidden-input"
          type="file"
          accept=".glb,model/gltf-binary"
          multiple
          onChange={(event) => {
            handleLayerModelFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={mapSlotInputRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          onChange={(event) => {
            handleLayerMapFile(pendingMapSlotRef.current, event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        <header className="panel-head">
          <div className="brand">
            <span className="eyebrow">Fabric Bake</span>
            <h1>Studio</h1>
          </div>
          <button
            className="ghost-button"
            type="button"
            aria-label="Toggle color mode"
            title="Toggle color mode"
            onClick={() => updateOption("darkMode", !viewOptions.darkMode)}
          >
            {viewOptions.darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>

        <div className="upload-grid">
          <button
            className={`upload-card ${selectedHasModel ? "filled" : ""}`}
            type="button"
            onClick={() => openLayerUpload()}
          >
            <span className="upload-icon">
              <Box size={20} />
            </span>
            <span className="upload-text">
              <strong>Model</strong>
              <small>{selectedHasModel ? selectedLayer.name : "Upload .glb files"}</small>
            </span>
            <Upload className="upload-action" size={16} />
          </button>
          <button
            className={`upload-card ${selectedLayer.fabricSet?.maps?.fabricMap ? "filled" : ""}`}
            type="button"
            onClick={() => openMapSlotUpload("fabricMap")}
          >
            <span className="upload-icon">
              <Shirt size={20} />
            </span>
            <span className="upload-text">
              <strong>Fabric</strong>
              <small>{selectedLayer.fabricSet?.maps?.fabricMap?.name || "Layer swatch"}</small>
            </span>
            <Upload className="upload-action" size={16} />
          </button>
        </div>

        <section className="panel-block">
          <span className="block-title">Selected layer maps</span>
          <div className="map-slot-grid">
            {FABRIC_MAP_SLOT_ORDER.map((slot) => {
              const map = selectedLayer.fabricSet?.maps?.[slot];
              return (
                <button
                  key={slot}
                  className={`map-slot ${map ? "filled" : ""}`}
                  type="button"
                  onClick={() => openMapSlotUpload(slot)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onDrop={(event) => handleMapSlotDrop(event, slot)}
                >
                  <FileImage size={15} />
                  <span>{FABRIC_MAP_LABELS[slot]}</span>
                  <small>{map?.name || "Drop image"}</small>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel-block">
          <div className="block-head">
            <span className="block-title">Layers</span>
            <button
              className="ghost-button small"
              type="button"
              title="Add layer"
              aria-label="Add layer"
              onClick={addLayer}
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="layer-list">
            {layers.map((layer) => {
              const hasModel = Boolean(layer.source || layer.isPreview);
              const isSelected = layer.id === selectedLayer.id;
              return (
                <div
                  key={layer.id}
                  className={`layer-row ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedLayerId(layer.id)}
                >
                  <button
                    className="row-icon"
                    type="button"
                    title={layer.visible ? "Hide layer" : "Show layer"}
                    aria-label={layer.visible ? "Hide layer" : "Show layer"}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateLayer(layer.id, { visible: !layer.visible });
                    }}
                  >
                    {layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                  </button>

                  {editingLayerId === layer.id ? (
                    <input
                      className="layer-name editing"
                      aria-label="Layer name"
                      autoFocus
                      value={layer.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => setEditingLayerId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "Escape") {
                          event.currentTarget.blur();
                        }
                      }}
                      onChange={(event) => updateLayer(layer.id, { name: event.target.value })}
                    />
                  ) : (
                    <button
                      className="layer-name layer-name-button"
                      type="button"
                      title="Double-click to rename"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedLayerId(layer.id);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        setEditingLayerId(layer.id);
                      }}
                    >
                      {layer.name}
                    </button>
                  )}

                  <button
                    className={`pill-toggle ${layer.bakeFabric ? "on" : ""}`}
                    type="button"
                    title={hasModel ? "Apply fabric to this layer" : "Add a model first"}
                    disabled={!hasModel}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateLayer(layer.id, { bakeFabric: !layer.bakeFabric });
                    }}
                  >
                    <Shirt size={14} />
                  </button>

                  <button
                    className="row-icon danger"
                    type="button"
                    title="Remove layer"
                    aria-label="Remove layer"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeLayer(layer.id);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel-block">
          <div className="block-head">
            <span className="block-title">Fabric scale</span>
            <span className="block-meta">
              {isTileDisabled ? "UV atlas" : `${fabricRepeat.x.toFixed(1)} × ${fabricRepeat.y.toFixed(1)} repeats`}
            </span>
          </div>
          <label className="slider-row with-value">
            <span>Tile</span>
            <input
              type="range"
              min={TILE_SIZE_MIN}
              max={TILE_SIZE_MAX}
              step={TILE_SIZE_STEP}
              value={viewOptions.fabricTileWidth}
              disabled={isTileDisabled}
              onChange={(event) => updateTileSize("fabricTileWidth", Number(event.target.value))}
            />
            <input
              aria-label="Tile size"
              className="numeric-input"
              type="number"
              min={TILE_SIZE_MIN}
              max={TILE_SIZE_MAX}
              step={TILE_SIZE_STEP}
              value={tileInputs.fabricTileWidth}
              disabled={isTileDisabled}
              onBlur={() => handleTileInputBlur("fabricTileWidth")}
              onChange={(event) => handleTileInputChange("fabricTileWidth", event.target.value)}
            />
          </label>
        </section>

        <section className="panel-block">
          <span className="block-title">Fabric material</span>
          <label className="slider-row with-value">
            <span>Roughness</span>
            <input
              type="range"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={viewOptions.fabricRoughness}
              disabled={hasRoughnessMap}
              onChange={(event) =>
                updateOption("fabricRoughness", clampMaterialValue(Number(event.target.value)))
              }
            />
            <input
              aria-label="Roughness value"
              className="numeric-input"
              type="number"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={formatMaterialValue(viewOptions.fabricRoughness)}
              disabled={hasRoughnessMap}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateOption("fabricRoughness", clampMaterialValue(nextValue));
                }
              }}
            />
          </label>
          <label className="slider-row with-value">
            <span>Sheen</span>
            <input
              type="range"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={viewOptions.fabricSheen}
              onChange={(event) =>
                updateOption("fabricSheen", clampMaterialValue(Number(event.target.value)))
              }
            />
            <input
              aria-label="Sheen value"
              className="numeric-input"
              type="number"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={formatMaterialValue(viewOptions.fabricSheen)}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateOption("fabricSheen", clampMaterialValue(nextValue));
                }
              }}
            />
          </label>
          <label className="slider-row with-value">
            <span>Weave</span>
            <input
              type="range"
              min={NORMAL_STRENGTH_MIN}
              max={NORMAL_STRENGTH_MAX}
              step={NORMAL_STRENGTH_STEP}
              value={viewOptions.fabricNormalStrength}
              disabled={hasNormalMap}
              onChange={(event) =>
                updateOption("fabricNormalStrength", clampNormalStrength(Number(event.target.value)))
              }
            />
            <input
              aria-label="Weave depth value"
              className="numeric-input"
              type="number"
              min={NORMAL_STRENGTH_MIN}
              max={NORMAL_STRENGTH_MAX}
              step={NORMAL_STRENGTH_STEP}
              value={formatMaterialValue(viewOptions.fabricNormalStrength)}
              disabled={hasNormalMap}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateOption("fabricNormalStrength", clampNormalStrength(nextValue));
                }
              }}
            />
          </label>
          <label className="slider-row with-value">
            <span>Metallic</span>
            <input
              type="range"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={viewOptions.fabricMetalness}
              disabled={hasMetalnessMap}
              onChange={(event) =>
                updateOption("fabricMetalness", clampMaterialValue(Number(event.target.value)))
              }
            />
            <input
              aria-label="Metallic value"
              className="numeric-input"
              type="number"
              min={MATERIAL_MIN}
              max={MATERIAL_MAX}
              step={MATERIAL_STEP}
              value={formatMaterialValue(viewOptions.fabricMetalness)}
              disabled={hasMetalnessMap}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateOption("fabricMetalness", clampMaterialValue(nextValue));
                }
              }}
            />
          </label>
        </section>

        <section className="panel-block">
          <span className="block-title">Lighting</span>
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
        </section>

        <div className="action-row">
          <button
            className="action-button"
            type="button"
            onClick={() => sceneApiRef.current?.resetView()}
          >
            <Maximize2 size={16} />
            <span>Frame</span>
          </button>
          <button
            className="action-button primary"
            type="button"
            onClick={() => sceneApiRef.current?.exportViewport(makeDownloadName(selectedLayer.name))}
          >
            <Download size={16} />
            <span>Export PNG</span>
          </button>
        </div>

        {summaryItems.length > 0 && (
          <div className="stats-grid" aria-label="Model stats">
            {summaryItems.map(([label, value]) => (
              <div key={label} className="stat-cell">
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        )}
      </aside>
    </main>
  );
}

export default App;
