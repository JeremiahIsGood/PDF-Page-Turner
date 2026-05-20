const DEFAULT_INTERVAL_KEY = "pdf-page-turner-default-interval";
const TIMINGS_KEY = "pdf-page-turner-page-timings";
const LAST_PAGE_KEY = "pdf-page-turner-last-page";
const DB_NAME = "pdf-page-turner";
const DB_VERSION = 1;
const FILE_STORE = "files";
const LAST_FILE_ID = "last-pdf";
const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const elements = {
  fileInput: document.getElementById("fileInput"),
  secondaryFileInput: document.getElementById("secondaryFileInput"),
  pdfCanvas: document.getElementById("pdfCanvas"),
  emptyState: document.getElementById("emptyState"),
  loadingState: document.getElementById("loadingState"),
  documentName: document.getElementById("documentName"),
  pageStatus: document.getElementById("pageStatus"),
  previousButton: document.getElementById("previousButton"),
  nextButton: document.getElementById("nextButton"),
  previousZone: document.getElementById("previousZone"),
  nextZone: document.getElementById("nextZone"),
  defaultInterval: document.getElementById("defaultInterval"),
  pageInterval: document.getElementById("pageInterval"),
  savePageTiming: document.getElementById("savePageTiming"),
  clearPageTiming: document.getElementById("clearPageTiming"),
  startPauseButton: document.getElementById("startPauseButton"),
  installButton: document.getElementById("installButton"),
  restoreButton: document.getElementById("restoreButton"),
  fullscreenButton: document.getElementById("fullscreenButton"),
};

const state = {
  pdf: null,
  currentPage: 1,
  totalPages: 0,
  renderTask: null,
  autoTimer: null,
  isAutoRunning: false,
  fileKey: null,
  pageTimings: {},
  deferredInstallPrompt: null,
  resizeTimer: null,
  lastLayoutWidth: 0,
  lastLayoutHeight: 0,
  isPinching: false,
  lastPinchAt: 0,
  isImmersive: false,
};

const canvasContext = elements.pdfCanvas.getContext("2d");

function loadDefaultInterval() {
  const saved = Number(localStorage.getItem(DEFAULT_INTERVAL_KEY));
  elements.defaultInterval.value = Number.isFinite(saved) && saved > 0 ? saved : 5;
}

function saveDefaultInterval() {
  const interval = readInterval(elements.defaultInterval.value);
  if (interval) {
    localStorage.setItem(DEFAULT_INTERVAL_KEY, String(interval));
  }
}

function readInterval(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }
  return Math.max(0.5, numericValue);
}

function allStoredTimings() {
  try {
    return JSON.parse(localStorage.getItem(TIMINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistCurrentTimings() {
  if (!state.fileKey) {
    return;
  }

  const stored = allStoredTimings();
  stored[state.fileKey] = state.pageTimings;
  localStorage.setItem(TIMINGS_KEY, JSON.stringify(stored));
}

function loadTimingsFor(file) {
  state.fileKey = `${file.name}:${file.size}:${file.lastModified}`;
  state.pageTimings = allStoredTimings()[state.fileKey] || {};
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRecord(record) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readLastRecord() {
  const db = await openDatabase();
  const record = await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readonly");
    const request = transaction.objectStore(FILE_STORE).get(LAST_FILE_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
}

async function saveLastPdf(file, data) {
  try {
    await storeRecord({
      id: LAST_FILE_ID,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      data: data.slice(0),
      page: state.currentPage,
      savedAt: Date.now(),
    });
    await refreshRestoreButton();
  } catch (error) {
    console.warn("Could not save PDF for restore", error);
  }
}

async function saveCurrentPagePosition() {
  if (!state.pdf) {
    return;
  }

  localStorage.setItem(LAST_PAGE_KEY, String(state.currentPage));
}

async function refreshRestoreButton() {
  try {
    const record = await readLastRecord();
    if (!record) {
      elements.restoreButton.classList.add("hidden");
      return;
    }

    elements.restoreButton.textContent = `Restore ${record.name}`;
    elements.restoreButton.classList.remove("hidden");
  } catch {
    elements.restoreButton.classList.add("hidden");
  }
}

async function importPdf(file) {
  if (!file) {
    return;
  }

  stopAutoTurn();
  setLoading(true);
  elements.emptyState.classList.add("hidden");
  elements.documentName.textContent = file.name;
  loadTimingsFor(file);

  try {
    await waitForPdfJs();
    const data = await file.arrayBuffer();
    state.pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    state.currentPage = 1;
    state.totalPages = state.pdf.numPages;
    localStorage.setItem(LAST_PAGE_KEY, "1");
    await saveLastPdf(file, data);
    await renderPage();
  } catch (error) {
    console.error(error);
    resetViewer("Could not load this PDF");
  } finally {
    setLoading(false);
  }
}

async function restoreLastPdf() {
  stopAutoTurn();
  setLoading(true);
  elements.emptyState.classList.add("hidden");

  try {
    const record = await readLastRecord();
    if (!record?.data) {
      resetViewer("No saved PDF found");
      return;
    }

    await waitForPdfJs();
    elements.documentName.textContent = record.name;
    loadTimingsFor(record);
    state.pdf = await pdfjsLib.getDocument({ data: record.data.slice(0) }).promise;
    state.totalPages = state.pdf.numPages;
    const savedPage = Number(localStorage.getItem(LAST_PAGE_KEY)) || record.page || 1;
    state.currentPage = Math.min(Math.max(savedPage, 1), state.totalPages);
    await renderPage();
  } catch (error) {
    console.error(error);
    resetViewer("Could not restore the last PDF");
  } finally {
    setLoading(false);
  }
}

function waitForPdfJs() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
        resolve();
        return;
      }

      attempts += 1;
      if (attempts > 80) {
        reject(new Error("PDF.js did not load"));
        return;
      }

      window.setTimeout(check, 100);
    };

    check();
  });
}

function setLoading(isLoading) {
  elements.loadingState.classList.toggle("hidden", !isLoading);
}

function resetViewer(message) {
  state.pdf = null;
  state.currentPage = 1;
  state.totalPages = 0;
  state.fileKey = null;
  state.pageTimings = {};
  elements.documentName.textContent = message;
  elements.emptyState.classList.remove("hidden");
  updatePageStatus();
}

async function renderPage() {
  if (!state.pdf) {
    updatePageStatus();
    return;
  }

  if (state.renderTask) {
    state.renderTask.cancel();
  }

  const page = await state.pdf.getPage(state.currentPage);
  const container = document.querySelector(".viewer-panel");
  const availableWidth = Math.max(300, container.clientWidth - 28);
  const availableHeight = Math.max(280, container.clientHeight - 28);
  state.lastLayoutWidth = container.clientWidth;
  state.lastLayoutHeight = container.clientHeight;
  const baseViewport = page.getViewport({ scale: 1 });
  const displayScale = Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: displayScale });

  elements.pdfCanvas.width = Math.floor(viewport.width * outputScale);
  elements.pdfCanvas.height = Math.floor(viewport.height * outputScale);
  elements.pdfCanvas.style.width = `${Math.floor(viewport.width)}px`;
  elements.pdfCanvas.style.height = `${Math.floor(viewport.height)}px`;

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  const renderTask = page.render({ canvasContext, viewport, transform });
  state.renderTask = renderTask;

  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      console.error(error);
    }
  } finally {
    if (state.renderTask === renderTask) {
      state.renderTask = null;
    }
  }

  updatePageStatus();
  updatePageTimingField();
}

function updatePageStatus() {
  elements.pageStatus.textContent = `Page ${state.totalPages ? state.currentPage : 0} / ${state.totalPages}`;
}

function updatePageTimingField() {
  const timing = state.pageTimings[state.currentPage];
  elements.pageInterval.value = timing || "";
  elements.pageInterval.placeholder = timing ? "" : "Default";
}

async function goToPage(pageNumber) {
  if (!state.pdf) {
    return;
  }

  const nextPage = Math.min(Math.max(pageNumber, 1), state.totalPages);
  if (nextPage === state.currentPage) {
    return;
  }

  state.currentPage = nextPage;
  await renderPage();
  saveCurrentPagePosition();

  if (state.isAutoRunning) {
    scheduleAutoTurn();
  }
}

function scheduleResponsiveRender() {
  if (!state.pdf) {
    return;
  }

  const container = document.querySelector(".viewer-panel");
  const widthChanged = Math.abs(container.clientWidth - state.lastLayoutWidth) > 12;
  const heightChanged = Math.abs(container.clientHeight - state.lastLayoutHeight) > 12;
  const recentlyPinched = Date.now() - state.lastPinchAt < 500;

  if ((!widthChanged && !heightChanged) || state.isPinching || recentlyPinched) {
    return;
  }

  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(() => renderPage(), 250);
}

function currentInterval() {
  return readInterval(state.pageTimings[state.currentPage]) || readInterval(elements.defaultInterval.value) || 5;
}

function scheduleAutoTurn() {
  window.clearTimeout(state.autoTimer);

  if (!state.isAutoRunning || !state.pdf) {
    return;
  }

  state.autoTimer = window.setTimeout(async () => {
    if (state.currentPage >= state.totalPages) {
      stopAutoTurn();
      return;
    }

    await goToPage(state.currentPage + 1);
  }, currentInterval() * 1000);
}

function startAutoTurn() {
  if (!state.pdf) {
    return;
  }

  saveDefaultInterval();
  state.isAutoRunning = true;
  elements.startPauseButton.textContent = "Pause Auto Turn";
  elements.startPauseButton.classList.add("is-running");
  scheduleAutoTurn();
}

function stopAutoTurn() {
  state.isAutoRunning = false;
  window.clearTimeout(state.autoTimer);
  elements.startPauseButton.textContent = "Start Auto Turn";
  elements.startPauseButton.classList.remove("is-running");
}

function saveTimingForCurrentPage() {
  if (!state.pdf) {
    return;
  }

  const interval = readInterval(elements.pageInterval.value);
  if (!interval) {
    return;
  }

  state.pageTimings[state.currentPage] = interval;
  persistCurrentTimings();
  updatePageTimingField();

  if (state.isAutoRunning) {
    scheduleAutoTurn();
  }
}

function clearTimingForCurrentPage() {
  if (!state.pdf) {
    return;
  }

  delete state.pageTimings[state.currentPage];
  persistCurrentTimings();
  updatePageTimingField();

  if (state.isAutoRunning) {
    scheduleAutoTurn();
  }
}

async function enterFullscreen() {
  const shell = document.querySelector(".app-shell");

  try {
    if (shell.requestFullscreen) {
      await shell.requestFullscreen();
    } else if (shell.webkitRequestFullscreen) {
      shell.webkitRequestFullscreen();
    } else {
      enterImmersiveMode();
    }
  } catch {
    enterImmersiveMode();
  }

  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    enterImmersiveMode();
  }
}

async function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }

  if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
    return;
  }

  exitImmersiveMode();
}

function enterImmersiveMode() {
  if (state.isImmersive) {
    return;
  }

  state.isImmersive = true;
  document.body.classList.add("immersive-mode");
  elements.fullscreenButton.textContent = "Exit Fullscreen";
  ensureImmersiveExitButton();

  window.setTimeout(() => renderPage(), 80);
}

function exitImmersiveMode() {
  state.isImmersive = false;
  document.body.classList.remove("immersive-mode");
  elements.fullscreenButton.textContent = "Fullscreen";
  document.getElementById("immersiveExitButton")?.remove();
  window.setTimeout(() => renderPage(), 80);
}

function ensureImmersiveExitButton() {
  if (document.getElementById("immersiveExitButton")) {
    return;
  }

  const exitButton = document.createElement("button");
  exitButton.className = "immersive-exit";
  exitButton.id = "immersiveExitButton";
  exitButton.type = "button";
  exitButton.textContent = "Exit";
  exitButton.addEventListener("click", exitFullscreen);
  document.body.appendChild(exitButton);
}

function syncFullscreenState() {
  const isNativeFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (isNativeFullscreen) {
    state.isImmersive = false;
    document.body.classList.add("immersive-mode");
    elements.fullscreenButton.textContent = "Exit Fullscreen";
    ensureImmersiveExitButton();
  } else if (!state.isImmersive) {
    document.body.classList.remove("immersive-mode");
    elements.fullscreenButton.textContent = "Fullscreen";
    document.getElementById("immersiveExitButton")?.remove();
  }

  window.setTimeout(() => renderPage(), 80);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(console.error);
  }
}

function wireEvents() {
  elements.fileInput.addEventListener("change", (event) => importPdf(event.target.files[0]));
  elements.secondaryFileInput.addEventListener("change", (event) => importPdf(event.target.files[0]));
  elements.restoreButton.addEventListener("click", restoreLastPdf);
  elements.previousButton.addEventListener("click", () => goToPage(state.currentPage - 1));
  elements.nextButton.addEventListener("click", () => goToPage(state.currentPage + 1));
  elements.previousZone.addEventListener("click", () => handlePageTap(-1));
  elements.nextZone.addEventListener("click", () => handlePageTap(1));
  elements.savePageTiming.addEventListener("click", saveTimingForCurrentPage);
  elements.clearPageTiming.addEventListener("click", clearTimingForCurrentPage);
  elements.defaultInterval.addEventListener("change", () => {
    saveDefaultInterval();
    if (state.isAutoRunning) {
      scheduleAutoTurn();
    }
  });
  elements.startPauseButton.addEventListener("click", () => {
    if (state.isAutoRunning) {
      stopAutoTurn();
    } else {
      startAutoTurn();
    }
  });
  elements.fullscreenButton.addEventListener("click", () => {
    if (document.fullscreenElement || document.webkitFullscreenElement || state.isImmersive) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  });
  window.addEventListener("resize", scheduleResponsiveRender);
  window.visualViewport?.addEventListener("resize", scheduleResponsiveRender);
  document.addEventListener("fullscreenchange", syncFullscreenState);
  document.addEventListener("webkitfullscreenchange", syncFullscreenState);
  document.addEventListener("touchstart", (event) => {
    if (event.touches.length > 1) {
      state.isPinching = true;
      state.lastPinchAt = Date.now();
    }
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) {
      state.lastPinchAt = Date.now();
      window.setTimeout(() => {
        state.isPinching = false;
      }, 350);
    }
  }, { passive: true });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.classList.remove("hidden");
  });
  elements.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      return;
    }

    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    elements.installButton.classList.add("hidden");
  });
}

function handlePageTap(direction) {
  if (state.isPinching || Date.now() - state.lastPinchAt < 450) {
    return;
  }

  goToPage(state.currentPage + direction);
}

loadDefaultInterval();
wireEvents();
registerServiceWorker();
updatePageStatus();
refreshRestoreButton();
