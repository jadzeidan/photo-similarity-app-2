const state = {
  view: "home",
  snapshots: [],
  activeSnapshotId: null,
  stagedCompareImage: null,
  compareMode: "blinker",
  blinkerMs: 1200,
  blinkerTimer: null,
  blinkerShowingCurrent: true,
  stream: null,
  cameraReady: false,
};

const PIN_POINTS = [
  { x: 184 / 362, y: 27 / 362 },
  { x: 96 / 362, y: 304 / 362 },
  { x: 270 / 362, y: 301 / 362 },
];

const NORMALIZED_SIZE = 1024;
const CANONICAL_DOTS = [
  { x: (184 / 362) * NORMALIZED_SIZE, y: (27 / 362) * NORMALIZED_SIZE },
  { x: (96 / 362) * NORMALIZED_SIZE, y: (304 / 362) * NORMALIZED_SIZE },
  { x: (270 / 362) * NORMALIZED_SIZE, y: (301 / 362) * NORMALIZED_SIZE },
];
const CANONICAL_RING = {
  cx: (181 / 362) * NORMALIZED_SIZE,
  cy: (181 / 362) * NORMALIZED_SIZE,
  r: (180 / 362) * NORMALIZED_SIZE,
};

const db = {
  instance: null,
  async open() {
    if (this.instance) return this.instance;
    this.instance = await new Promise((resolve, reject) => {
      const request = indexedDB.open("entropyseal-db", 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("snapshots")) {
          database.createObjectStore("snapshots", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.instance;
  },
  async getAll() {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("snapshots", "readonly");
      const request = tx.objectStore("snapshots").getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
      request.onerror = () => reject(request.error);
    });
  },
  async put(snapshot) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(snapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async delete(id) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

const refs = {
  appMain: document.getElementById("appMain"),
  backBtn: document.getElementById("backBtn"),
  primaryAction: document.getElementById("primaryAction"),
  screenTitle: document.getElementById("screenTitle"),
  screenSubtitle: document.getElementById("screenSubtitle"),
  nameDialog: document.getElementById("nameDialog"),
  nameForm: document.getElementById("nameForm"),
  nameInput: document.getElementById("nameInput"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmBody: document.getElementById("confirmBody"),
  confirmForm: document.getElementById("confirmForm"),
};

async function init() {
  await loadSnapshots();
  wireShellEvents();
  render();
}

async function loadSnapshots() {
  state.snapshots = await db.getAll();
}

function wireShellEvents() {
  refs.backBtn.addEventListener("click", () => {
    stopCamera();
    stopBlinker();
    if (state.view === "snapshot" || state.view === "camera") {
      state.view = "home";
      state.activeSnapshotId = null;
    } else if (state.view === "compare") {
      state.view = "snapshot";
      state.stagedCompareImage = null;
      state.compareMode = "blinker";
      state.blinkerShowingCurrent = true;
    }
    render();
  });

  refs.primaryAction.addEventListener("click", async () => {
    if (state.view === "home") {
      state.view = "camera";
      state.captureTarget = "newSnapshot";
      render();
      await startCamera();
    }
  });
}

function setHeader(title, subtitle = "") {
  refs.screenTitle.textContent = title;
  refs.screenSubtitle.textContent = subtitle;
}

function setShell({ showBack, primaryText, primaryVisible }) {
  refs.backBtn.classList.toggle("hidden", !showBack);
  refs.primaryAction.classList.toggle("hidden", !primaryVisible);
  if (primaryText) refs.primaryAction.textContent = primaryText;
}

function render() {
  refs.appMain.innerHTML = "";

  if (state.view === "home") {
    renderHome();
    return;
  }
  if (state.view === "camera") {
    renderCamera();
    return;
  }
  if (state.view === "snapshot") {
    renderSnapshot();
    return;
  }
  if (state.view === "compare") {
    renderCompare();
  }
}

function renderHome() {
  setHeader("Snapshots", "EntropySeal");
  setShell({ showBack: false, primaryText: "Take Snapshot", primaryVisible: true });

  const fragment = document.getElementById("homeTemplate").content.cloneNode(true);
  const list = fragment.getElementById("snapshotList");
  const emptyState = fragment.getElementById("emptyState");

  if (!state.snapshots.length) {
    list.classList.add("hidden");
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
    state.snapshots.forEach((shot) => {
      const button = document.createElement("button");
      button.className = "snapshot-card";
      button.innerHTML = `
        <img class="snapshot-thumb" src="${shot.imageDataUrl}" alt="${escapeHtml(shot.name)}" />
        <div class="snapshot-meta">
          <h3>${escapeHtml(shot.name)}</h3>
          <p>${formatDate(shot.createdAt)}</p>
        </div>
      `;
      button.addEventListener("click", () => {
        state.activeSnapshotId = shot.id;
        state.view = "snapshot";
        render();
      });
      list.appendChild(button);
    });
  }

  refs.appMain.appendChild(fragment);
}

function renderCamera() {
  setHeader("Create Snapshot", "Align and capture the lid pattern");
  setShell({ showBack: true, primaryVisible: false });

  const fragment = document.getElementById("cameraTemplate").content.cloneNode(true);
  const captureBtn = fragment.getElementById("captureBtn");
  const video = fragment.getElementById("cameraVideo");
  const canvas = fragment.getElementById("captureCanvas");
  const fileInput = fragment.getElementById("fileInput");
  const countdown = fragment.getElementById("countdown");

  captureBtn.disabled = !state.cameraReady;
  captureBtn.textContent = state.cameraReady ? "Take Snapshot" : "Starting camera...";

  captureBtn.addEventListener("click", async () => {
    if (!state.cameraReady || !state.stream) {
      await startCamera();
      if (!state.cameraReady) {
        alert("Camera is still unavailable. Check browser camera permission.");
        return;
      }
    }
    const imageDataUrl = await performCountdownCapture(video, canvas, countdown);
    if (imageDataUrl) {
      await onImageCaptured(imageDataUrl);
    }
  });

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageDataUrl = await fileToDataUrl(file);
    await onImageCaptured(imageDataUrl);
  });

  refs.appMain.appendChild(fragment);

  if (state.stream) {
    video.srcObject = state.stream;
  }
}

function renderSnapshot() {
  const snapshot = getActiveSnapshot();
  if (!snapshot) {
    state.view = "home";
    render();
    return;
  }

  setHeader(snapshot.name, formatDate(snapshot.createdAt));
  setShell({ showBack: true, primaryVisible: false });

  const fragment = document.getElementById("snapshotTemplate").content.cloneNode(true);
  const image = fragment.getElementById("snapshotImg");
  const status = fragment.getElementById("snapshotStatus");
  image.src = snapshot.imageDataUrl;

  if (snapshot.lastVerifiedAt) {
    status.textContent = `Verified ${formatDate(snapshot.lastVerifiedAt)}`;
  } else {
    status.textContent = "Not verified yet";
    status.style.color = "var(--muted)";
  }

  fragment.getElementById("verifyBtn").addEventListener("click", async () => {
    state.view = "camera";
    state.captureTarget = "compareCurrent";
    render();
    await startCamera();
  });

  fragment.getElementById("renameBtn").addEventListener("click", async () => {
    const name = await promptForName(snapshot.name);
    if (!name) return;
    snapshot.name = name;
    await db.put(snapshot);
    await loadSnapshots();
    render();
  });

  fragment.getElementById("exportBtn").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = snapshot.imageDataUrl;
    a.download = `${snapshot.name.replace(/[^a-z0-9-_]/gi, "_") || "snapshot"}.png`;
    a.click();
  });

  fragment.getElementById("deleteBtn").addEventListener("click", async () => {
    const confirmed = await confirmAction(
      "Delete snapshot?",
      `This will permanently remove \"${snapshot.name}\" from this browser.`
    );
    if (!confirmed) return;

    await db.delete(snapshot.id);
    state.activeSnapshotId = null;
    state.view = "home";
    await loadSnapshots();
    render();
  });

  refs.appMain.appendChild(fragment);
}

function renderCompare() {
  const snapshot = getActiveSnapshot();
  if (!snapshot || !state.stagedCompareImage) {
    state.view = "snapshot";
    render();
    return;
  }

  setHeader("Compare Snapshot", snapshot.name);
  setShell({ showBack: true, primaryVisible: false });

  const fragment = document.getElementById("compareTemplate").content.cloneNode(true);
  const blinkerMode = fragment.getElementById("blinkerMode");
  const pinsMode = fragment.getElementById("pinsMode");
  const blinkerTab = fragment.getElementById("blinkerTab");
  const pinsTab = fragment.getElementById("pinsTab");

  blinkerTab.addEventListener("click", () => {
    state.compareMode = "blinker";
    render();
  });

  pinsTab.addEventListener("click", () => {
    state.compareMode = "pins";
    render();
  });

  if (state.compareMode === "blinker") {
    pinsMode.classList.add("hidden");
    blinkerMode.classList.remove("hidden");
    blinkerTab.classList.add("active");
    pinsTab.classList.remove("active");

    const blinkerImage = fragment.getElementById("blinkerImage");
    const blinkerLabel = fragment.getElementById("blinkerLabel");
    const speedSlider = fragment.getElementById("speedSlider");

    speedSlider.value = String(state.blinkerMs);
    speedSlider.addEventListener("input", () => {
      state.blinkerMs = Number(speedSlider.value);
      startBlinker(blinkerImage, blinkerLabel, snapshot.imageDataUrl, state.stagedCompareImage);
    });

    startBlinker(blinkerImage, blinkerLabel, snapshot.imageDataUrl, state.stagedCompareImage);
  } else {
    stopBlinker();
    pinsMode.classList.remove("hidden");
    blinkerMode.classList.add("hidden");
    blinkerTab.classList.remove("active");
    pinsTab.classList.add("active");

    const pinsGrid = fragment.getElementById("pinsGrid");
    renderPins(pinsGrid, snapshot.imageDataUrl, state.stagedCompareImage).catch((error) => {
      console.error(error);
      pinsGrid.innerHTML = "<p class=\"helper\">Unable to load pin crops.</p>";
    });
  }

  refs.appMain.appendChild(fragment);
}

async function renderPins(container, oldDataUrl, currentDataUrl) {
  const [oldImage, currentImage] = await Promise.all([
    loadImage(oldDataUrl),
    loadImage(currentDataUrl),
  ]);
  const labels = ["Pin 1", "Pin 2", "Pin 3"];
  PIN_POINTS.forEach((point, index) => {
    const oldCrop = createPinCrop(oldImage, point);
    const currentCrop = createPinCrop(currentImage, point);

    const oldCell = document.createElement("div");
    oldCell.className = "pin-cell";
    oldCell.innerHTML = `<p>${labels[index]}: Snapshot</p><img class="pin-image" alt="Old pin" src="${oldCrop}" />`;

    const currentCell = document.createElement("div");
    currentCell.className = "pin-cell";
    currentCell.innerHTML = `<p>${labels[index]}: Current</p><img class="pin-image" alt="Current pin" src="${currentCrop}" />`;

    container.appendChild(oldCell);
    container.appendChild(currentCell);
  });
}

function startBlinker(imgEl, labelEl, oldDataUrl, currentDataUrl) {
  stopBlinker();

  const paint = () => {
    if (state.blinkerShowingCurrent) {
      imgEl.src = currentDataUrl;
      labelEl.textContent = "Current";
    } else {
      imgEl.src = oldDataUrl;
      labelEl.textContent = "Snapshot";
    }
    state.blinkerShowingCurrent = !state.blinkerShowingCurrent;
  };

  paint();
  state.blinkerTimer = window.setInterval(paint, state.blinkerMs);
}

function stopBlinker() {
  if (state.blinkerTimer) {
    clearInterval(state.blinkerTimer);
    state.blinkerTimer = null;
  }
}

async function onImageCaptured(imageDataUrl) {
  stopCamera();
  let normalizedImageDataUrl = imageDataUrl;
  try {
    normalizedImageDataUrl = await normalizeCapturedImage(imageDataUrl);
  } catch (error) {
    console.error("Normalization failed, using original capture.", error);
  }

  if (state.captureTarget === "newSnapshot") {
    const snapshot = {
      id: crypto.randomUUID(),
      name: `Snapshot ${state.snapshots.length + 1}`,
      imageDataUrl: normalizedImageDataUrl,
      createdAt: Date.now(),
      lastVerifiedAt: null,
    };

    await db.put(snapshot);
    await loadSnapshots();
    state.activeSnapshotId = snapshot.id;
    state.view = "snapshot";
    render();
    return;
  }

  if (state.captureTarget === "compareCurrent") {
    state.stagedCompareImage = normalizedImageDataUrl;
    const active = getActiveSnapshot();
    if (active) {
      active.lastVerifiedAt = Date.now();
      await db.put(active);
      await loadSnapshots();
    }
    state.view = "compare";
    state.compareMode = "blinker";
    state.blinkerShowingCurrent = true;
    render();
  }
}

async function startCamera() {
  state.cameraReady = false;
  setCameraUiReady(false);
  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
    } catch {
      // Fallback for browsers/devices that reject advanced constraints.
      state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    const videoEl = document.getElementById("cameraVideo");
    if (videoEl) {
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      videoEl.srcObject = state.stream;
      videoEl.onloadedmetadata = async () => {
        try {
          await videoEl.play();
        } catch {
          // Some browsers require explicit gesture even after metadata arrives.
        }
      };
      try {
        await videoEl.play();
      } catch {
        // Some mobile browsers require an additional explicit user tap to start preview.
      }
    }
    state.cameraReady = true;
    setCameraUiReady(true);
  } catch (error) {
    alert("Camera unavailable. You can still upload an image instead.");
    state.stream = null;
    state.cameraReady = false;
    setCameraUiReady(false);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  state.cameraReady = false;
  setCameraUiReady(false);
}

async function performCountdownCapture(videoEl, canvasEl, countdownEl) {
  if (!videoEl.srcObject && state.stream) {
    videoEl.srcObject = state.stream;
    try {
      await videoEl.play();
    } catch {
      // Ignore and continue to explicit stream check below.
    }
  }

  for (let n = 3; n >= 1; n -= 1) {
    countdownEl.textContent = String(n);
    countdownEl.classList.remove("hidden");
    await sleep(700);
  }
  countdownEl.classList.add("hidden");

  if (!videoEl.srcObject) {
    alert("No camera stream found. Please allow camera access or use image upload.");
    return null;
  }

  const width = videoEl.videoWidth || 1024;
  const height = videoEl.videoHeight || 1024;
  const size = Math.min(width, height);
  const sx = (width - size) / 2;
  const sy = (height - size) / 2;

  canvasEl.width = 1024;
  canvasEl.height = 1024;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, sx, sy, size, size, 0, 0, 1024, 1024);
  return canvasEl.toDataURL("image/png");
}

async function normalizeCapturedImage(imageDataUrl) {
  const source = await loadImage(imageDataUrl);
  const squareCanvas = document.createElement("canvas");
  squareCanvas.width = NORMALIZED_SIZE;
  squareCanvas.height = NORMALIZED_SIZE;
  const squareCtx = squareCanvas.getContext("2d");

  const cropSize = Math.min(source.width, source.height);
  const sx = (source.width - cropSize) / 2;
  const sy = (source.height - cropSize) / 2;
  squareCtx.drawImage(source, sx, sy, cropSize, cropSize, 0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);

  const detectedDots = detectReferenceDots(squareCanvas);
  if (!detectedDots) {
    return squareCanvas.toDataURL("image/png");
  }

  const orderedDots = orderObservedDots(detectedDots);
  if (!orderedDots) {
    return squareCanvas.toDataURL("image/png");
  }

  const transform = computeBestAffineTransform(orderedDots, CANONICAL_DOTS);
  if (!transform) {
    return squareCanvas.toDataURL("image/png");
  }

  const normalizedCanvas = document.createElement("canvas");
  normalizedCanvas.width = NORMALIZED_SIZE;
  normalizedCanvas.height = NORMALIZED_SIZE;
  const outCtx = normalizedCanvas.getContext("2d");
  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
  outCtx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  outCtx.drawImage(squareCanvas, 0, 0);
  outCtx.setTransform(1, 0, 0, 1, 0, 0);

  // Keep only the template circle area so all snapshots share the same framing.
  outCtx.globalCompositeOperation = "destination-in";
  outCtx.beginPath();
  outCtx.arc(CANONICAL_RING.cx, CANONICAL_RING.cy, CANONICAL_RING.r, 0, Math.PI * 2);
  outCtx.fill();
  outCtx.globalCompositeOperation = "destination-over";
  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
  outCtx.globalCompositeOperation = "source-over";

  return normalizedCanvas.toDataURL("image/png");
}

function detectReferenceDots(sourceCanvas) {
  const sampleSize = 256;
  const sample = document.createElement("canvas");
  sample.width = sampleSize;
  sample.height = sampleSize;
  const ctx = sample.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, sampleSize, sampleSize);

  const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
  const cx = sampleSize / 2;
  const cy = sampleSize / 2;
  const ringR = sampleSize * 0.5;
  const minR = ringR * 0.66;
  const maxR = ringR * 0.95;
  const mask = new Uint8Array(sampleSize * sampleSize);

  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.hypot(dx, dy);
      if (radius < minR || radius > maxR) continue;

      const i = (y * sampleSize + x) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray < 55) {
        mask[y * sampleSize + x] = 1;
      }
    }
  }

  const components = connectedComponents(mask, sampleSize, sampleSize);
  const candidates = components
    .filter((comp) => comp.area >= 14 && comp.area <= 280)
    .map((comp) => ({
      x: (comp.cx / sampleSize) * NORMALIZED_SIZE,
      y: (comp.cy / sampleSize) * NORMALIZED_SIZE,
      area: comp.area,
    }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 20);

  if (candidates.length < 3) return null;
  const best = pickBestDotTriple(candidates);
  return best;
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queueX = [];
  const queueY = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) continue;

      let head = 0;
      queueX.length = 0;
      queueY.length = 0;
      queueX.push(x);
      queueY.push(y);
      visited[idx] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      while (head < queueX.length) {
        const qx = queueX[head];
        const qy = queueY[head];
        head += 1;
        area += 1;
        sumX += qx;
        sumY += qy;

        for (let ny = qy - 1; ny <= qy + 1; ny += 1) {
          for (let nx = qx - 1; nx <= qx + 1; nx += 1) {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (!mask[nIdx] || visited[nIdx]) continue;
            visited[nIdx] = 1;
            queueX.push(nx);
            queueY.push(ny);
          }
        }
      }

      components.push({
        area,
        cx: sumX / area,
        cy: sumY / area,
      });
    }
  }

  return components;
}

function pickBestDotTriple(candidates) {
  const center = NORMALIZED_SIZE / 2;
  let bestScore = Infinity;
  let bestTriple = null;

  for (let i = 0; i < candidates.length - 2; i += 1) {
    for (let j = i + 1; j < candidates.length - 1; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const points = [candidates[i], candidates[j], candidates[k]];
        const distances = [
          distance(points[0], points[1]),
          distance(points[0], points[2]),
          distance(points[1], points[2]),
        ].sort((a, b) => a - b);

        const maxD = distances[2];
        if (maxD < 120) continue;
        const shortRatio = distances[0] / maxD;
        const midRatio = distances[1] / maxD;

        const radii = points.map((p) => Math.hypot(p.x - center, p.y - center));
        const meanRadius = (radii[0] + radii[1] + radii[2]) / 3;
        const radiusSpread = Math.max(...radii) - Math.min(...radii);

        const score =
          Math.abs(shortRatio - 0.605) * 4 +
          Math.abs(midRatio - 0.989) * 2 +
          Math.abs(meanRadius - CANONICAL_RING.r * 0.84) / CANONICAL_RING.r +
          radiusSpread / CANONICAL_RING.r;

        if (score < bestScore) {
          bestScore = score;
          bestTriple = points;
        }
      }
    }
  }

  return bestScore < 2.4 ? bestTriple : null;
}

function orderObservedDots(points) {
  if (!points || points.length !== 3) return null;
  const pairs = [
    { a: 0, b: 1, d: distance(points[0], points[1]) },
    { a: 0, b: 2, d: distance(points[0], points[2]) },
    { a: 1, b: 2, d: distance(points[1], points[2]) },
  ].sort((m, n) => m.d - n.d);

  const base = pairs[0];
  const topIndex = [0, 1, 2].find((idx) => idx !== base.a && idx !== base.b);
  if (topIndex === undefined) return null;

  const top = points[topIndex];
  const p1 = points[base.a];
  const p2 = points[base.b];
  return [top, p1, p2];
}

function computeBestAffineTransform(observedDots, targetDots) {
  const first = solveAffine(observedDots, targetDots);
  const swappedObserved = [observedDots[0], observedDots[2], observedDots[1]];
  const second = solveAffine(swappedObserved, targetDots);

  if (first && first.det > 0) return first;
  if (second && second.det > 0) return second;
  return first || second || null;
}

function solveAffine(src, dst) {
  const m = [
    [src[0].x, src[0].y, 1],
    [src[1].x, src[1].y, 1],
    [src[2].x, src[2].y, 1],
  ];
  const u = [dst[0].x, dst[1].x, dst[2].x];
  const v = [dst[0].y, dst[1].y, dst[2].y];

  const xCoeffs = solveLinear3(m, u);
  const yCoeffs = solveLinear3(m, v);
  if (!xCoeffs || !yCoeffs) return null;

  const [a, c, e] = xCoeffs;
  const [b, d, f] = yCoeffs;
  return { a, b, c, d, e, f, det: a * d - b * c };
}

function solveLinear3(matrix, values) {
  const m = matrix.map((row, i) => [...row, values[i]]);

  for (let pivot = 0; pivot < 3; pivot += 1) {
    let best = pivot;
    for (let r = pivot + 1; r < 3; r += 1) {
      if (Math.abs(m[r][pivot]) > Math.abs(m[best][pivot])) best = r;
    }
    if (Math.abs(m[best][pivot]) < 1e-8) return null;
    if (best !== pivot) {
      const tmp = m[pivot];
      m[pivot] = m[best];
      m[best] = tmp;
    }

    const factor = m[pivot][pivot];
    for (let c = pivot; c < 4; c += 1) m[pivot][c] /= factor;

    for (let r = 0; r < 3; r += 1) {
      if (r === pivot) continue;
      const scale = m[r][pivot];
      for (let c = pivot; c < 4; c += 1) m[r][c] -= scale * m[pivot][c];
    }
  }

  return [m[0][3], m[1][3], m[2][3]];
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createPinCrop(source, point) {
  const canvas = document.createElement("canvas");
  const output = 256;
  const radius = 130;
  canvas.width = output;
  canvas.height = output;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, output, output);

  const cx = source.width * point.x;
  const cy = source.height * point.y;
  ctx.beginPath();
  ctx.arc(output / 2, output / 2, output / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(source, cx - radius, cy - radius, radius * 2, radius * 2, 0, 0, output, output);

  return canvas.toDataURL("image/png");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image for pins view."));
    img.src = src;
  });
}

function getActiveSnapshot() {
  return state.snapshots.find((s) => s.id === state.activeSnapshotId) || null;
}

function promptForName(currentName) {
  refs.nameInput.value = currentName;
  refs.nameDialog.showModal();

  return new Promise((resolve) => {
    refs.nameForm.onsubmit = (event) => {
      event.preventDefault();
      const action = event.submitter?.value;
      refs.nameDialog.close();
      if (action !== "confirm") {
        resolve(null);
        return;
      }
      resolve(refs.nameInput.value.trim() || currentName);
    };
  });
}

function confirmAction(title, body) {
  refs.confirmTitle.textContent = title;
  refs.confirmBody.textContent = body;
  refs.confirmDialog.showModal();

  return new Promise((resolve) => {
    refs.confirmForm.onsubmit = (event) => {
      event.preventDefault();
      const ok = event.submitter?.value === "confirm";
      refs.confirmDialog.close();
      resolve(ok);
    };
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setCameraUiReady(ready) {
  const captureBtn = document.getElementById("captureBtn");
  if (!captureBtn) return;
  captureBtn.disabled = !ready;
  captureBtn.textContent = ready ? "Take Snapshot" : "Starting camera...";
}

window.addEventListener("beforeunload", () => {
  stopCamera();
  stopBlinker();
});

init().catch((error) => {
  console.error(error);
  alert("Failed to initialize app.");
});
