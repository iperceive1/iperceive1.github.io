import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GALLERY_BASE = 'static/gallery';

/* ── Tunable constants ──────────────────────────────── */
const POINT_SIZE_MIN = 0.001;
const POINT_SIZE_MAX = 0.05;
const POINT_SIZE_DEFAULT = 0.004;
const BG_DARK = 0x1a1a2e;
const BG_LIGHT = 0xf0f0f0;

let renderer, scene, camera, controls;
let currentObjects = [];
let pointsMaterial = null;
let manifest = { cases: [] };
let loadingAbort = null;
let currentDatasetCases = [];

/* ── Initialisation ─────────────────────────────────── */

function initThree() {
  const canvas = document.getElementById('gallery-canvas');
  if (!canvas) return;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  fitCanvas();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_DARK);

  camera = new THREE.PerspectiveCamera(
    60, canvas.clientWidth / canvas.clientHeight, 0.01, 200
  );
  camera.up.set(0, 0, 1);
  camera.position.set(0, -4, 2);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  // Z-up: constrain rotation so roll stays locked
  controls.maxPolarAngle = Math.PI * 0.95;
  controls.minPolarAngle = Math.PI * 0.05;

  scene.add(new THREE.AmbientLight(0xffffff, 1));

  window.addEventListener('resize', onResize);
  animate();
}

function fitCanvas() {
  const wrap = document.querySelector('.gallery-viewer-wrap');
  if (!wrap || !renderer) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight || 500;
  renderer.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function onResize() { fitCanvas(); }

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

/* ── Scene management ───────────────────────────────── */

function clearScene() {
  currentObjects.forEach(obj => {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  currentObjects = [];
  pointsMaterial = null;
}

function addToScene(obj) {
  scene.add(obj);
  currentObjects.push(obj);
}

/* ── Frustum geometry ───────────────────────────────── */

function transformPoint(pose, p) {
  return [
    pose[0][0]*p[0] + pose[0][1]*p[1] + pose[0][2]*p[2] + pose[0][3],
    pose[1][0]*p[0] + pose[1][1]*p[1] + pose[1][2]*p[2] + pose[1][3],
    pose[2][0]*p[0] + pose[2][1]*p[1] + pose[2][2]*p[2] + pose[2][3],
  ];
}

function createFrustumLines(pose, fov, aspect, scale, colorArr) {
  const halfH = Math.tan(fov / 2) * scale;
  const halfW = halfH * aspect;

  const local = [
    [0, 0, 0],
    [-halfW, -halfH, scale],
    [ halfW, -halfH, scale],
    [ halfW,  halfH, scale],
    [-halfW,  halfH, scale],
  ];

  const w = local.map(p => transformPoint(pose, p));

  const edges = [
    [0,1],[0,2],[0,3],[0,4],
    [1,2],[2,3],[3,4],[4,1],
  ];

  const positions = [];
  edges.forEach(([i, j]) => positions.push(...w[i], ...w[j]));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const color = new THREE.Color(colorArr[0]/255, colorArr[1]/255, colorArr[2]/255);
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 2 });

  return new THREE.LineSegments(geo, mat);
}

/* ── Trajectory ─────────────────────────────────────── */

function createTrajectory(traj) {
  const pts = traj.points;
  if (!pts || pts.length < 2) return null;

  const positions = [];
  for (let i = 0; i < pts.length - 1; i++) {
    positions.push(...pts[i], ...pts[i+1]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const c = traj.color;
  const color = new THREE.Color(c[0]/255, c[1]/255, c[2]/255);
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 2 });

  return new THREE.LineSegments(geo, mat);
}

/* ── Load a case ────────────────────────────────────── */

async function loadCase(caseInfo) {
  if (loadingAbort) loadingAbort.abort();
  const ac = new AbortController();
  loadingAbort = ac;

  setLoading(true);
  clearScene();

  const basePath = `${GALLERY_BASE}/${caseInfo.path}`;

  let sceneData;
  try {
    const resp = await fetch(`${basePath}/scene.json`, { signal: ac.signal });
    sceneData = await resp.json();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Failed to load scene.json', e);
    setLoading(false);
    return;
  }

  updateInfoPanel(basePath, sceneData);

  // Load PLY
  const loader = new PLYLoader();
  try {
    const geometry = await new Promise((resolve, reject) => {
      loader.load(`${basePath}/points.ply`, resolve, undefined, reject);
    });
    if (ac.signal.aborted) return;

    const sizeSlider = document.getElementById('gallery-point-size');
    const initSize = sizeSlider ? parseFloat(sizeSlider.value) : POINT_SIZE_DEFAULT;
    pointsMaterial = new THREE.PointsMaterial({ size: initSize, vertexColors: true });
    const points = new THREE.Points(geometry, pointsMaterial);
    addToScene(points);

    // Frame camera to bounding box center, looking from a horizontal angle
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.boundingBox.getSize(size);
    controls.target.copy(center);

    const maxXY = Math.max(size.x, size.y);
    const dist = maxXY * 1.6;
    camera.position.set(
      center.x - dist * 0.5,
      center.y - dist * 0.85,
      center.z + size.z * 0.35
    );
    camera.lookAt(center);
    controls.update();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Failed to load PLY', e);
  }

  // GT cameras (only visible ones by default)
  if (sceneData.gt_cameras) {
    sceneData.gt_cameras.forEach(cam => {
      if (!cam.visible) return;
      const frustum = createFrustumLines(cam.pose, sceneData.fov_rad, 1.0, 0.20, cam.color);
      addToScene(frustum);
    });
  }

  // Algorithm cameras
  if (sceneData.algorithms) {
    sceneData.algorithms.forEach(algo => {
      const frustum = createFrustumLines(algo.pose, sceneData.fov_rad, 1.0, 0.26, algo.color);
      addToScene(frustum);
    });
  }

  // VLN trajectory
  if (sceneData.vln_trajectory) {
    const traj = createTrajectory(sceneData.vln_trajectory);
    if (traj) addToScene(traj);
  }

  setLoading(false);
  loadingAbort = null;
}

/* ── UI helpers ─────────────────────────────────────── */

function setLoading(on) {
  const el = document.getElementById('gallery-loading');
  if (el) el.hidden = !on;
}

function updateInfoPanel(basePath, sd) {
  const instrEl = document.getElementById('gallery-instruction-text');
  if (instrEl) instrEl.textContent = sd.instruction || '';

  // Input images
  const inputRow = document.getElementById('gallery-input-images');
  if (inputRow) {
    inputRow.innerHTML = '';
    const imgs = [];
    if (sd.images.start) imgs.push({ src: `${basePath}/${sd.images.start}`, label: 'Start' });
    (sd.images.context || []).forEach((p, i) => {
      imgs.push({ src: `${basePath}/${p}`, label: `Ctx ${i}` });
    });
    if (sd.images.target) imgs.push({ src: `${basePath}/${sd.images.target}`, label: 'Target (GT)' });

    imgs.forEach(({ src, label }) => {
      const wrap = document.createElement('div');
      wrap.className = 'gallery-thumb';
      wrap.innerHTML = `<img src="${src}" alt="${label}"><span>${label}</span>`;
      inputRow.appendChild(wrap);
    });
  }

  // Render images
  const renderRow = document.getElementById('gallery-render-images');
  if (renderRow) {
    renderRow.innerHTML = '';
    const renders = sd.images.renders || {};
    (sd.algorithms || []).forEach(algo => {
      const rPath = renders[algo.key];
      if (!rPath) return;
      const wrap = document.createElement('div');
      wrap.className = 'gallery-thumb';
      const borderColor = `rgb(${algo.color.join(',')})`;
      wrap.innerHTML = `<img src="${basePath}/${rPath}" alt="${algo.paper_name}" style="border:3px solid ${borderColor}"><span>${algo.paper_name}</span>`;
      renderRow.appendChild(wrap);
    });
  }

  // Legend
  const legendEl = document.getElementById('gallery-legend');
  if (legendEl) {
    legendEl.innerHTML = '';
    legendEl.innerHTML += legendItem([144,238,144], 'Target (GT)');
    (sd.algorithms || []).forEach(a => {
      legendEl.innerHTML += legendItem(a.color, a.paper_name);
    });
  }

  // Metrics table
  const metricsEl = document.getElementById('gallery-metrics');
  if (metricsEl && sd.algorithms && sd.algorithms.length > 0) {
    let html = '<table><thead><tr><th>Method</th><th>F1 ↑</th><th>Trans. ↓</th><th>Rot. ↓</th></tr></thead><tbody>';
    sd.algorithms.forEach(a => {
      const m = a.metrics || {};
      const borderLeft = `border-left:3px solid rgb(${a.color.join(',')})`;
      html += `<tr style="${borderLeft}">`;
      html += `<td>${a.paper_name}</td>`;
      html += `<td>${fmt(m.soft_f1)}</td>`;
      html += `<td>${fmtDist(m.trans_error)}</td>`;
      html += `<td>${fmtAngle(m.rot_error)}</td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    metricsEl.innerHTML = html;
    metricsEl.hidden = false;
  }
}

function legendItem(color, label) {
  return `<span class="legend-item"><span class="legend-swatch" style="background:rgb(${color.join(',')})"></span>${label}</span>`;
}

function fmt(v) { return v != null ? v.toFixed(3) : '—'; }
function fmtDist(v) { return v != null ? v.toFixed(2) + 'm' : '—'; }
function fmtAngle(v) { return v != null ? (v * 180 / Math.PI).toFixed(1) + '°' : '—'; }

/* ── Controls wiring ────────────────────────────────── */

function updateCasesForDataset() {
  const ds = document.getElementById('gallery-dataset').value;
  currentDatasetCases = manifest.cases.filter(c => c.dataset === ds);

  const caseInput = document.getElementById('gallery-case');
  const caseMax = document.getElementById('gallery-case-max');
  caseInput.max = currentDatasetCases.length;
  caseInput.value = 1;
  if (caseMax) caseMax.textContent = `/ ${currentDatasetCases.length}`;

  if (currentDatasetCases.length > 0) loadCase(currentDatasetCases[0]);
}

function onCaseChange() {
  const caseInput = document.getElementById('gallery-case');
  let idx = parseInt(caseInput.value, 10);
  if (isNaN(idx)) return;
  idx = Math.max(1, Math.min(idx, currentDatasetCases.length));
  caseInput.value = idx;
  if (currentDatasetCases[idx - 1]) loadCase(currentDatasetCases[idx - 1]);
}

function onBgToggle() {
  const cb = document.getElementById('gallery-bg-toggle');
  if (!cb || !scene) return;
  scene.background = new THREE.Color(cb.checked ? BG_LIGHT : BG_DARK);
  const wrap = document.querySelector('.gallery-viewer-wrap');
  if (wrap) wrap.style.background = cb.checked ? '#f0f0f0' : '#1a1a2e';
}

function onPointSizeChange() {
  const slider = document.getElementById('gallery-point-size');
  if (!slider || !pointsMaterial) return;
  pointsMaterial.size = parseFloat(slider.value);
  const label = document.getElementById('gallery-point-size-val');
  if (label) label.textContent = parseFloat(slider.value).toFixed(3);
}

/* ── Bootstrap ──────────────────────────────────────── */

async function initGallery() {
  initThree();

  try {
    const resp = await fetch(`${GALLERY_BASE}/manifest.json`);
    manifest = await resp.json();
  } catch (e) {
    console.error('Failed to load gallery manifest', e);
    return;
  }

  if (manifest.cases.length === 0) return;

  // Dataset dropdown
  const datasets = [...new Set(manifest.cases.map(c => c.dataset))];
  const dsSelect = document.getElementById('gallery-dataset');
  datasets.forEach(ds => {
    const opt = document.createElement('option');
    opt.value = ds;
    opt.textContent = ds.toUpperCase();
    dsSelect.appendChild(opt);
  });
  dsSelect.addEventListener('change', updateCasesForDataset);

  // Case index input
  const caseInput = document.getElementById('gallery-case');
  caseInput.addEventListener('change', onCaseChange);

  // Background toggle
  const bgToggle = document.getElementById('gallery-bg-toggle');
  if (bgToggle) bgToggle.addEventListener('change', onBgToggle);

  // Point size slider
  const sizeSlider = document.getElementById('gallery-point-size');
  if (sizeSlider) {
    sizeSlider.min = POINT_SIZE_MIN;
    sizeSlider.max = POINT_SIZE_MAX;
    sizeSlider.step = 0.0005;
    sizeSlider.value = POINT_SIZE_DEFAULT;
    sizeSlider.addEventListener('input', onPointSizeChange);
    const label = document.getElementById('gallery-point-size-val');
    if (label) label.textContent = POINT_SIZE_DEFAULT.toFixed(3);
  }

  updateCasesForDataset();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGallery);
} else {
  initGallery();
}
