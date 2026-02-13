// ============================================================
// Google Maps Data Extractor - Content Script
// Extrae datos de negocios de los resultados de búsqueda
// ============================================================

(function () {
  "use strict";

  let isExtracting = false;
  let shouldStop = false;

  // --- Utilidades ---

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendProgress(current, total, status) {
    chrome.runtime.sendMessage({
      action: "progress",
      current,
      total,
      status,
    });
  }

  function sendResults(data) {
    chrome.runtime.sendMessage({ action: "results", data });
  }

  function sendError(message) {
    chrome.runtime.sendMessage({ action: "error", message });
  }

  function sendLog(message) {
    chrome.runtime.sendMessage({ action: "log", message });
  }

  // --- Selectores con fallback ---

  function querySelector(parent, selectors) {
    for (const sel of selectors) {
      const el = parent.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function querySelectorAll(parent, selectors) {
    for (const sel of selectors) {
      const els = parent.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    }
    return [];
  }

  // --- Fase 1: Localizar panel de resultados y hacer scroll ---

  function getResultsContainer() {
    // El panel de resultados en Google Maps
    const selectors = [
      'div[role="feed"]',
      'div[role="list"]',
      ".m6QErb.DxyBCb.kA9KIf.dS8AEf",
      ".m6QErb.DxyBCb",
      ".m6QErb",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Fallback: buscar el contenedor scrollable del sidebar
    const sidebar = document.querySelector(
      'div[role="main"] .m6QErb.DxyBCb'
    );
    if (sidebar) return sidebar;

    return null;
  }

  async function scrollToLoadAll(container) {
    sendLog("Fase 1: Haciendo scroll para cargar todos los resultados...");

    let previousHeight = 0;
    let sameHeightCount = 0;
    const maxSameHeight = 5;
    let scrollAttempts = 0;
    const maxScrollAttempts = 50;

    while (sameHeightCount < maxSameHeight && scrollAttempts < maxScrollAttempts) {
      if (shouldStop) return;

      container.scrollTop = container.scrollHeight;
      await sleep(1200);

      const currentHeight = container.scrollHeight;

      if (currentHeight === previousHeight) {
        sameHeightCount++;
      } else {
        sameHeightCount = 0;
      }

      previousHeight = currentHeight;
      scrollAttempts++;

      // Verificar si llegamos al final (mensaje "No hay más resultados")
      const endOfList = container.querySelector(".HlvSq");
      if (endOfList) {
        sendLog("Se alcanzó el final de la lista de resultados.");
        break;
      }
    }

    // Volver al inicio
    container.scrollTop = 0;
    await sleep(500);
  }

  // --- Fase 2: Recolectar elementos de resultados ---

  function getResultElements() {
    const selectors = [
      'div[role="feed"] > div > div[jsaction]',
      'div[role="feed"] .Nv2PK',
      ".Nv2PK",
      'div[role="article"]',
    ];

    let results = [];
    for (const sel of selectors) {
      results = Array.from(document.querySelectorAll(sel));
      if (results.length > 0) break;
    }

    // Filtrar solo los que parecen ser resultados reales (tienen un enlace o nombre)
    return results.filter((el) => {
      const hasLink = el.querySelector("a[href]");
      const hasName =
        el.querySelector(".qBF1Pd") ||
        el.querySelector(".fontHeadlineSmall") ||
        el.querySelector('[class*="fontHeadline"]');
      return hasLink || hasName;
    });
  }

  function extractBasicInfo(element) {
    // Nombre
    const nameEl = querySelector(element, [
      ".qBF1Pd",
      ".fontHeadlineSmall",
      '[class*="fontHeadline"]',
      "h3",
      'a[aria-label][href*="/maps/place/"]',
    ]);
    const nombre = nameEl
      ? nameEl.textContent?.trim() || nameEl.getAttribute("aria-label") || ""
      : "";

    // Rating
    const ratingEl = querySelector(element, [
      'span[role="img"][aria-label*="estrella"]',
      'span[role="img"][aria-label*="star"]',
      ".MW4etd",
    ]);
    let rating = "";
    if (ratingEl) {
      const ariaLabel = ratingEl.getAttribute("aria-label") || "";
      const match = ariaLabel.match(/([\d,.]+)/);
      rating = match ? match[1] : ratingEl.textContent?.trim() || "";
    }

    // Dirección parcial (de la lista)
    const infoBlocks = querySelectorAll(element, [".W4Efsd", ".lI9IFe"]);
    let direccionParcial = "";
    let categoria = "";

    for (const block of infoBlocks) {
      const spans = block.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent?.trim() || "";
        if (!text || text === "·" || text === "·") continue;

        // Detectar si es una dirección (contiene números o palabras clave)
        if (
          /\d/.test(text) &&
          !text.includes("★") &&
          !text.match(/^\([\d,.]+\)$/) &&
          text.length > 5
        ) {
          if (!direccionParcial) direccionParcial = text;
        }
      }
    }

    // Link del lugar
    const linkEl = element.querySelector('a[href*="/maps/place/"]');
    const link = linkEl ? linkEl.getAttribute("href") : "";

    return { nombre, rating, direccionParcial, link, categoria };
  }

  // --- Fase 3: Click-through para extraer datos completos ---

  async function waitForDetailPanel(timeout = 8000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Buscar panel de detalle cargado
      const phoneBtn = document.querySelector(
        'button[data-item-id^="phone:"], a[data-item-id^="phone:"], a[href^="tel:"]'
      );
      const addressBtn = document.querySelector(
        'button[data-item-id="address"], button[data-item-id^="oloc"]'
      );
      const titleEl = document.querySelector(
        'h1.DUwDvf, h1[class*="fontHeadline"], div[role="main"] h1'
      );

      if (titleEl && (phoneBtn || addressBtn)) {
        return true;
      }

      // Al menos esperar a que cargue el título
      if (titleEl && Date.now() - startTime > 3000) {
        return true;
      }

      await sleep(300);
    }

    return false;
  }

  function extractDetailData() {
    const data = {
      nombre: "",
      direccion: "",
      ciudad: "",
      provincia: "",
      telefono: "",
      rating: "",
      website: "",
      categoria: "",
    };

    // Nombre desde panel de detalle
    const titleEl = querySelector(document, [
      "h1.DUwDvf",
      'h1[class*="fontHeadline"]',
      'div[role="main"] h1',
    ]);
    if (titleEl) data.nombre = titleEl.textContent?.trim() || "";

    // Teléfono - CLAVE
    const phoneEl = querySelector(document, [
      'button[data-item-id^="phone:tel:"]',
      'a[data-item-id^="phone:tel:"]',
      'button[data-item-id^="phone:"]',
      'a[data-item-id^="phone:"]',
      'a[href^="tel:"]',
    ]);
    if (phoneEl) {
      // Extraer del data-item-id
      const dataId = phoneEl.getAttribute("data-item-id") || "";
      if (dataId.startsWith("phone:tel:")) {
        data.telefono = dataId.replace("phone:tel:", "").replace(/-/g, " ");
      } else if (dataId.startsWith("phone:")) {
        data.telefono = dataId.replace("phone:", "").replace(/-/g, " ");
      }

      // Fallback: del texto visible o aria-label
      if (!data.telefono) {
        const ariaLabel = phoneEl.getAttribute("aria-label") || "";
        const phoneMatch = ariaLabel.match(
          /(?:Teléfono|Phone|Celular):\s*([\d\s+\-()]+)/i
        );
        if (phoneMatch) {
          data.telefono = phoneMatch[1].trim();
        } else {
          // Del texto visible del botón
          const phoneText =
            phoneEl.querySelector(".Io6YTe, .fontBodyMedium")?.textContent ||
            phoneEl.textContent ||
            "";
          if (/[\d+]/.test(phoneText)) {
            data.telefono = phoneText.trim();
          }
        }
      }

      // Último fallback: href tel:
      if (!data.telefono) {
        const telHref =
          phoneEl.getAttribute("href") ||
          phoneEl.querySelector("a[href^='tel:']")?.getAttribute("href") ||
          "";
        if (telHref.startsWith("tel:")) {
          data.telefono = telHref.replace("tel:", "").replace(/-/g, " ");
        }
      }
    }

    // Dirección completa
    const addressEl = querySelector(document, [
      'button[data-item-id="address"]',
      'button[data-item-id^="oloc"]',
      '[data-item-id="address"]',
    ]);
    if (addressEl) {
      const addrText =
        addressEl.querySelector(".Io6YTe, .fontBodyMedium")?.textContent ||
        addressEl.getAttribute("aria-label")?.replace(/^Dirección:\s*|^Address:\s*/i, "") ||
        addressEl.textContent ||
        "";
      data.direccion = addrText.trim();

      // Intentar parsear ciudad y provincia de la dirección
      const parsed = parseDireccion(data.direccion);
      data.ciudad = parsed.ciudad;
      data.provincia = parsed.provincia;
    }

    // Website
    const websiteEl = querySelector(document, [
      'a[data-item-id="authority"]',
      'a[data-item-id^="authority"]',
      'button[data-item-id="authority"]',
    ]);
    if (websiteEl) {
      data.website =
        websiteEl.getAttribute("href") ||
        websiteEl.querySelector(".Io6YTe, .fontBodyMedium")?.textContent ||
        websiteEl.getAttribute("aria-label")?.replace(/^Sitio web:\s*|^Website:\s*/i, "") ||
        "";
      data.website = data.website.trim();
    }

    // Rating
    const ratingEl = querySelector(document, [
      'div[role="main"] span[role="img"][aria-label*="estrella"]',
      'div[role="main"] span[role="img"][aria-label*="star"]',
      "div.F7nice span",
      ".MW4etd",
    ]);
    if (ratingEl) {
      const ariaLabel = ratingEl.getAttribute("aria-label") || "";
      const match = ariaLabel.match(/([\d,.]+)/);
      data.rating = match ? match[1] : ratingEl.textContent?.trim() || "";
    }

    // Categoría
    const categoryEl = querySelector(document, [
      'button[jsaction*="category"]',
      ".DkEaL",
      'div[role="main"] button[class*="DkEaL"]',
    ]);
    if (categoryEl) {
      data.categoria = categoryEl.textContent?.trim() || "";
    }

    return data;
  }

  function parseDireccion(direccion) {
    let ciudad = "";
    let provincia = "";

    if (!direccion) return { ciudad, provincia };

    // Formato típico argentino: "Calle 123, Localidad, Provincia, País"
    // Formato general: "Calle 123, Ciudad, Estado/Provincia CÓDIGO, País"
    const parts = direccion.split(",").map((p) => p.trim());

    if (parts.length >= 3) {
      // Usualmente: [calle, ciudad, provincia/estado, país]
      ciudad = parts[parts.length - 3] || parts[1] || "";
      provincia = parts[parts.length - 2] || "";

      // Limpiar código postal de la provincia
      provincia = provincia.replace(/\b[A-Z]?\d{4,6}\b/g, "").trim();
    } else if (parts.length === 2) {
      ciudad = parts[1] || "";
    }

    return { ciudad: ciudad.trim(), provincia: provincia.trim() };
  }

  async function clickBackToList() {
    // Botón de volver atrás en el panel de detalle
    const backBtnSelectors = [
      'button[aria-label="Atrás"]',
      'button[aria-label="Back"]',
      'button[jsaction*="back"]',
      ".hYBOP button",
      'button[aria-label="Volver"]',
      'button.VfPpkd-icon-LgbsSe[aria-label]',
    ];

    for (const sel of backBtnSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        await sleep(1500);
        return true;
      }
    }

    // Fallback: usar el navegador history
    window.history.back();
    await sleep(2000);
    return true;
  }

  async function waitForListToReload(timeout = 6000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const feed = document.querySelector('div[role="feed"]');
      const results = document.querySelectorAll(
        'div[role="feed"] .Nv2PK, div[role="feed"] > div > div[jsaction]'
      );
      if (feed && results.length > 0) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  // --- Algoritmo principal de extracción ---

  async function extractAll() {
    if (isExtracting) {
      sendError("Ya hay una extracción en curso.");
      return;
    }

    isExtracting = true;
    shouldStop = false;

    try {
      // Fase 1: Encontrar el contenedor y hacer scroll
      const container = getResultsContainer();
      if (!container) {
        sendError(
          "No se encontró la lista de resultados de Google Maps. Asegúrate de haber hecho una búsqueda."
        );
        isExtracting = false;
        return;
      }

      sendLog("Iniciando extracción de datos...");
      await scrollToLoadAll(container);

      if (shouldStop) {
        sendLog("Extracción detenida por el usuario.");
        isExtracting = false;
        return;
      }

      // Fase 2: Obtener todos los elementos de resultados
      const resultElements = getResultElements();
      const totalResults = resultElements.length;

      if (totalResults === 0) {
        sendError(
          "No se encontraron resultados en la lista. Intenta buscar algo en Google Maps primero."
        );
        isExtracting = false;
        return;
      }

      sendLog(`Fase 2: Se encontraron ${totalResults} resultados. Iniciando extracción detallada...`);
      sendProgress(0, totalResults, "Preparando extracción...");

      const allData = [];

      // Fase 3: Click en cada resultado para obtener datos completos
      for (let i = 0; i < totalResults; i++) {
        if (shouldStop) {
          sendLog("Extracción detenida por el usuario.");
          break;
        }

        sendProgress(i + 1, totalResults, `Procesando: resultado ${i + 1} de ${totalResults}`);

        // Re-obtener los elementos porque el DOM puede cambiar
        const currentElements = getResultElements();
        if (i >= currentElements.length) {
          sendLog(`No se pudo acceder al resultado ${i + 1}. Continuando...`);
          continue;
        }

        const element = currentElements[i];

        // Extraer info básica de la lista
        const basicInfo = extractBasicInfo(element);
        sendLog(`Procesando: ${basicInfo.nombre || "Resultado " + (i + 1)}`);

        // Click en el resultado para abrir detalle
        const clickTarget =
          element.querySelector("a[href]") ||
          element.querySelector('[class*="fontHeadline"]') ||
          element;

        try {
          clickTarget.click();
        } catch (e) {
          element.click();
        }

        // Esperar a que cargue el panel de detalle
        await sleep(800);
        const detailLoaded = await waitForDetailPanel();

        let detailData = {
          nombre: basicInfo.nombre,
          direccion: basicInfo.direccionParcial,
          ciudad: "",
          provincia: "",
          telefono: "",
          rating: basicInfo.rating,
          website: "",
          categoria: "",
        };

        if (detailLoaded) {
          detailData = extractDetailData();

          // Usar nombre de la lista como fallback
          if (!detailData.nombre && basicInfo.nombre) {
            detailData.nombre = basicInfo.nombre;
          }
          // Usar dirección parcial como fallback
          if (!detailData.direccion && basicInfo.direccionParcial) {
            detailData.direccion = basicInfo.direccionParcial;
          }
          // Usar rating de la lista como fallback
          if (!detailData.rating && basicInfo.rating) {
            detailData.rating = basicInfo.rating;
          }
        } else {
          sendLog(`No se pudo cargar el detalle de: ${basicInfo.nombre}`);
        }

        allData.push(detailData);

        // Enviar resultados parciales
        sendResults(allData);

        // Volver a la lista
        await clickBackToList();
        await waitForListToReload();

        // Delay entre resultados para no sobrecargar
        await sleep(500);
      }

      // Fase 4: Enviar resultados finales
      sendLog(`Extracción completada. ${allData.length} resultados procesados.`);
      sendResults(allData);
      sendProgress(allData.length, totalResults, "Extracción completada");

      // Guardar en storage
      chrome.storage.local.set({ lastExtraction: allData });
    } catch (error) {
      sendError("Error durante la extracción: " + error.message);
    } finally {
      isExtracting = false;
    }
  }

  // --- Listener de mensajes desde popup ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startExtraction") {
      extractAll();
      sendResponse({ status: "started" });
    } else if (message.action === "stopExtraction") {
      shouldStop = true;
      sendResponse({ status: "stopping" });
    } else if (message.action === "ping") {
      sendResponse({ status: "alive" });
    }
    return true;
  });

  console.log("[Maps Extractor] Content script cargado y listo.");
})();
