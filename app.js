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
  { x: 0.5, y: 0.2 },
  { x: 0.26, y: 0.77 },
  { x: 0.74, y: 0.77 },
];

let cvReadyPromise = null;

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
  let processedImageDataUrl = imageDataUrl;
  try {
    processedImageDataUrl = await orientEntropySealImage(imageDataUrl);
  } catch (error) {
    console.warn("EntropySeal orientation skipped:", error);
  }

  if (state.captureTarget === "newSnapshot") {
    const snapshot = {
      id: crypto.randomUUID(),
      name: `Snapshot ${state.snapshots.length + 1}`,
      imageDataUrl: processedImageDataUrl,
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
    state.stagedCompareImage = processedImageDataUrl;
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

async function orientEntropySealImage(imageDataUrl) {
  await ensureOpenCvReady();
  const sourceImage = await loadImage(imageDataUrl);
  const sourceMat = cv.imread(sourceImage);
  const rotatedMat = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const thresholded = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.threshold(blur, thresholded, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cv.morphologyEx(thresholded, thresholded, cv.MORPH_OPEN, kernel);

    cv.findContours(thresholded, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const landmarks = findEntropySealLandmarks(contours, sourceMat.cols, sourceMat.rows);
    if (!landmarks) {
      return imageDataUrl;
    }

    const { center, apex } = landmarks;
    const apexAngle = (Math.atan2(center.y - apex.y, apex.x - center.x) * 180) / Math.PI;
    const rotationDegrees = 90 - apexAngle;
    const matrix = cv.getRotationMatrix2D(new cv.Point(center.x, center.y), rotationDegrees, 1);
    cv.warpAffine(
      sourceMat,
      rotatedMat,
      matrix,
      new cv.Size(sourceMat.cols, sourceMat.rows),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE
    );
    matrix.delete();

    return matToDataUrl(rotatedMat);
  } finally {
    sourceMat.delete();
    rotatedMat.delete();
    gray.delete();
    blur.delete();
    thresholded.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function findEntropySealLandmarks(contours, width, height) {
  const center = { x: width / 2, y: height / 2 };
  const minDim = Math.min(width, height);
  const minArea = minDim * minDim * 0.000015;
  const maxArea = minDim * minDim * 0.003;
  const minRingRadius = minDim * 0.2;
  const maxRingRadius = minDim * 0.49;
  const candidates = [];

  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < minArea || area > maxArea) {
      contour.delete();
      continue;
    }

    const perimeter = cv.arcLength(contour, true);
    if (!perimeter) {
      contour.delete();
      continue;
    }
    const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
    if (circularity < 0.35) {
      contour.delete();
      continue;
    }

    const moments = cv.moments(contour);
    if (!moments.m00) {
      contour.delete();
      continue;
    }
    const x = moments.m10 / moments.m00;
    const y = moments.m01 / moments.m00;
    const dx = x - center.x;
    const dy = y - center.y;
    const radius = Math.hypot(dx, dy);
    if (radius < minRingRadius || radius > maxRingRadius) {
      contour.delete();
      continue;
    }

    candidates.push({ x, y, radius });
    contour.delete();
  }

  if (candidates.length < 3) {
    return null;
  }

  let bestTriplet = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let a = 0; a < candidates.length - 2; a += 1) {
    for (let b = a + 1; b < candidates.length - 1; b += 1) {
      for (let c = b + 1; c < candidates.length; c += 1) {
        const points = [candidates[a], candidates[b], candidates[c]];
        const distances = [
          { key: [0, 1], value: distance(points[0], points[1]) },
          { key: [0, 2], value: distance(points[0], points[2]) },
          { key: [1, 2], value: distance(points[1], points[2]) },
        ].sort((left, right) => left.value - right.value);

        const base = distances[0].value;
        const side1 = distances[1].value;
        const side2 = distances[2].value;
        if (base < minDim * 0.08) {
          continue;
        }

        const avgSide = (side1 + side2) / 2;
        const equalSidePenalty = Math.abs(side1 - side2) / Math.max(avgSide, 1);
        const ratioPenalty = Math.abs(base / Math.max(avgSide, 1) - 0.78);
        const radii = points.map((point) => point.radius);
        const radiusSpread = Math.max(...radii) - Math.min(...radii);
        const ringPenalty = radiusSpread / (minDim * 0.1);
        const score = equalSidePenalty + ratioPenalty + ringPenalty;

        if (score < bestScore) {
          bestScore = score;
          bestTriplet = { points, basePair: distances[0].key };
        }
      }
    }
  }

  if (!bestTriplet || bestScore > 1.2) {
    return null;
  }

  const apexIndex = [0, 1, 2].find(
    (index) => index !== bestTriplet.basePair[0] && index !== bestTriplet.basePair[1]
  );
  if (apexIndex == null) {
    return null;
  }

  return {
    center,
    apex: bestTriplet.points[apexIndex],
  };
}

function matToDataUrl(mat) {
  const canvas = document.createElement("canvas");
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  cv.imshow(canvas, mat);
  return canvas.toDataURL("image/png");
}

function ensureOpenCvReady() {
  if (window.cv && typeof window.cv.Mat === "function") {
    return Promise.resolve();
  }
  if (cvReadyPromise) {
    return cvReadyPromise;
  }

  cvReadyPromise = new Promise((resolve, reject) => {
    let finished = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("OpenCV did not initialize in time."));
    }, 8000);

    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      window.removeEventListener("opencv-ready", checkReady);
    };

    const checkReady = () => {
      if (window.cv && typeof window.cv.Mat === "function") {
        cleanup();
        resolve();
      }
    };

    window.addEventListener("opencv-ready", checkReady);

    const attachRuntimeCallback = () => {
      if (!window.cv) return false;
      if (typeof window.cv.Mat === "function") {
        checkReady();
        return true;
      }
      const prior = window.cv.onRuntimeInitialized;
      window.cv.onRuntimeInitialized = () => {
        if (typeof prior === "function") {
          prior();
        }
        window.dispatchEvent(new Event("opencv-ready"));
      };
      return true;
    };

    if (!attachRuntimeCallback()) {
      const interval = window.setInterval(() => {
        if (finished) {
          clearInterval(interval);
          return;
        }
        if (attachRuntimeCallback()) {
          clearInterval(interval);
        }
      }, 100);
    }

    checkReady();
  });

  return cvReadyPromise;
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

function distance(pointA, pointB) {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
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
