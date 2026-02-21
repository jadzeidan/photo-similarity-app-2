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
};

const PIN_POINTS = [
  { x: 0.5, y: 0.2 },
  { x: 0.26, y: 0.77 },
  { x: 0.74, y: 0.77 },
];

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

  captureBtn.addEventListener("click", async () => {
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

  if (state.captureTarget === "newSnapshot") {
    const snapshot = {
      id: crypto.randomUUID(),
      name: `Snapshot ${state.snapshots.length + 1}`,
      imageDataUrl,
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
    state.stagedCompareImage = imageDataUrl;
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
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (error) {
    alert("Camera unavailable. You can still upload an image instead.");
    state.stream = null;
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

async function performCountdownCapture(videoEl, canvasEl, countdownEl) {
  for (let n = 3; n >= 1; n -= 1) {
    countdownEl.textContent = String(n);
    countdownEl.classList.remove("hidden");
    await sleep(700);
  }
  countdownEl.classList.add("hidden");

  if (!videoEl.srcObject) {
    alert("No camera stream found. Please use image upload.");
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

window.addEventListener("beforeunload", () => {
  stopCamera();
  stopBlinker();
});

init().catch((error) => {
  console.error(error);
  alert("Failed to initialize app.");
});
