// ============================================================
// Google Maps Data Extractor - Popup Script
// ============================================================

let currentData = [];

// --- Elementos del DOM ---
const btnExtract = document.getElementById("btn-extract");
const btnStop = document.getElementById("btn-stop");
const btnCsv = document.getElementById("btn-csv");
const btnJson = document.getElementById("btn-json");
const btnClear = document.getElementById("btn-clear");
const progressSection = document.getElementById("progress-section");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const logSection = document.getElementById("log-section");
const logText = document.getElementById("log-text");
const resultsSection = document.getElementById("results-section");
const resultsCount = document.getElementById("results-count");
const resultsBody = document.getElementById("results-body");
const notMapsWarning = document.getElementById("not-maps-warning");

// --- Verificar si estamos en Google Maps ---

async function checkIfMaps() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (
      tab &&
      tab.url &&
      (tab.url.includes("google.com/maps") ||
        tab.url.includes("google.com.ar/maps") ||
        tab.url.includes("maps.google.com"))
    ) {
      notMapsWarning.classList.add("hidden");
      btnExtract.disabled = false;
      return true;
    }
  } catch (e) {
    // Error al verificar
  }
  notMapsWarning.classList.remove("hidden");
  btnExtract.disabled = true;
  return false;
}

// --- Iniciar extracción ---

async function startExtraction() {
  const isMaps = await checkIfMaps();
  if (!isMaps) return;

  btnExtract.classList.add("hidden");
  btnStop.classList.remove("hidden");
  progressSection.classList.remove("hidden");
  logSection.classList.remove("hidden");
  resultsSection.classList.remove("hidden");

  progressFill.style.width = "0%";
  progressText.textContent = "Iniciando extracción...";
  logText.textContent = "Conectando con Google Maps...";
  currentData = [];
  resultsBody.innerHTML = "";
  resultsCount.textContent = "0";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    chrome.tabs.sendMessage(
      tab.id,
      { action: "startExtraction" },
      (response) => {
        if (chrome.runtime.lastError) {
          logText.textContent =
            "Error: No se pudo conectar con la pestaña. Recarga Google Maps e intenta de nuevo.";
          resetButtons();
        }
      }
    );
  } catch (error) {
    logText.textContent = "Error: " + error.message;
    resetButtons();
  }
}

// --- Detener extracción ---

async function stopExtraction() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    chrome.tabs.sendMessage(tab.id, { action: "stopExtraction" });
  } catch (e) {
    // Ignorar
  }
  resetButtons();
  logText.textContent = "Extracción detenida.";
}

function resetButtons() {
  btnExtract.classList.remove("hidden");
  btnStop.classList.add("hidden");
}

// --- Listener de mensajes del content script ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "progress":
      updateProgress(message.current, message.total, message.status);
      break;
    case "results":
      updateResults(message.data);
      break;
    case "error":
      logText.textContent = "Error: " + message.message;
      progressText.textContent = "Error";
      resetButtons();
      break;
    case "log":
      logText.textContent = message.message;
      break;
  }

  // Verificar si extracción completada
  if (
    message.action === "progress" &&
    message.status &&
    message.status.includes("completada")
  ) {
    resetButtons();
  }
});

function updateProgress(current, total, status) {
  const percentage = total > 0 ? (current / total) * 100 : 0;
  progressFill.style.width = percentage + "%";
  progressText.textContent = status || `${current} / ${total}`;
}

function updateResults(data) {
  currentData = data;
  resultsCount.textContent = data.length;

  resultsBody.innerHTML = "";
  data.forEach((item, index) => {
    const tr = document.createElement("tr");

    const phoneClass = item.telefono ? "phone-cell" : "no-phone";
    const phoneText = item.telefono || "Sin teléfono";

    tr.innerHTML = `
      <td>${index + 1}</td>
      <td title="${escapeHtml(item.nombre)}">${escapeHtml(item.nombre)}</td>
      <td title="${escapeHtml(item.direccion)}">${escapeHtml(item.direccion)}</td>
      <td title="${escapeHtml(item.ciudad)}">${escapeHtml(item.ciudad)}</td>
      <td title="${escapeHtml(item.provincia)}">${escapeHtml(item.provincia)}</td>
      <td class="${phoneClass}" title="${escapeHtml(phoneText)}">${escapeHtml(phoneText)}</td>
      <td>${escapeHtml(item.rating)}</td>
    `;
    resultsBody.appendChild(tr);
  });

  resultsSection.classList.remove("hidden");
}

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Exportar CSV ---

function exportCSV() {
  if (currentData.length === 0) return;

  const headers = [
    "Nombre",
    "Dirección",
    "Ciudad",
    "Provincia",
    "Teléfono",
    "Rating",
    "Website",
    "Categoría",
  ];
  const rows = currentData.map((item) => [
    item.nombre,
    item.direccion,
    item.ciudad,
    item.provincia,
    item.telefono,
    item.rating,
    item.website,
    item.categoria,
  ]);

  let csv = "\uFEFF"; // BOM para UTF-8 en Excel
  csv += headers.join(";") + "\n";
  rows.forEach((row) => {
    csv +=
      row.map((field) => '"' + (field || "").replace(/"/g, '""') + '"').join(";") + "\n";
  });

  downloadFile(csv, "maps_datos_" + getTimestamp() + ".csv", "text/csv;charset=utf-8;");
}

// --- Exportar JSON ---

function exportJSON() {
  if (currentData.length === 0) return;

  const json = JSON.stringify(currentData, null, 2);
  downloadFile(
    json,
    "maps_datos_" + getTimestamp() + ".json",
    "application/json"
  );
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function getTimestamp() {
  const now = new Date();
  return (
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "_" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0")
  );
}

// --- Limpiar datos ---

function clearData() {
  currentData = [];
  resultsBody.innerHTML = "";
  resultsCount.textContent = "0";
  resultsSection.classList.add("hidden");
  progressSection.classList.add("hidden");
  logSection.classList.add("hidden");
  chrome.storage.local.remove("lastExtraction");
}

// --- Cargar datos previos ---

async function loadPreviousData() {
  try {
    const result = await chrome.storage.local.get("lastExtraction");
    if (result.lastExtraction && result.lastExtraction.length > 0) {
      updateResults(result.lastExtraction);
    }
  } catch (e) {
    // Sin datos previos
  }
}

// --- Event Listeners ---

btnExtract.addEventListener("click", startExtraction);
btnStop.addEventListener("click", stopExtraction);
btnCsv.addEventListener("click", exportCSV);
btnJson.addEventListener("click", exportJSON);
btnClear.addEventListener("click", clearData);

// --- Inicialización ---
checkIfMaps();
loadPreviousData();
