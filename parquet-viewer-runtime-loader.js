(function () {
  const MANIFEST_URL = "./parquet-viewer-runtime/manifest.json";

  function manifestBaseUrl() {
    return new URL(MANIFEST_URL, window.location.href);
  }

  function resolveRuntimeUrl(value) {
    return new URL(value, manifestBaseUrl()).toString();
  }

  function loadStyles(styles) {
    for (const stylePath of styles || []) {
      const href = resolveRuntimeUrl(stylePath);
      if (document.querySelector(`link[data-parquet-viewer-runtime-style="true"][href="${href}"]`)) {
        continue;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.parquetViewerRuntimeStyle = "true";
      document.head.appendChild(link);
    }
  }

  function showRuntimeLoadError(message) {
    const root = document.getElementById("main");
    if (!root) {
      return;
    }
    const pre = document.createElement("pre");
    pre.style.cssText =
      "margin:1rem;padding:1rem;border-left:3px solid #ff6b6b;border-radius:8px;background:#fff;color:#ff6b6b;white-space:pre-wrap;";
    pre.textContent = `Failed to load Parquet viewer runtime.\n${message}`;
    root.prepend(pre);
  }

  async function loadParquetViewerRuntime() {
    const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const manifest = await response.json();
    loadStyles(manifest.styles);

    await new Promise((resolve, reject) => {
      const src = resolveRuntimeUrl(manifest.script);
      const existing = document.querySelector(`script[data-parquet-viewer-runtime="true"][src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("Parquet viewer runtime failed to load.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.type = "module";
      script.async = true;
      script.src = src;
      script.dataset.parquetViewerRuntime = "true";
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error("Parquet viewer runtime failed to load.")), { once: true });
      document.body.appendChild(script);
    });
  }

  window.__ozoneParquetViewerRuntimePromise = loadParquetViewerRuntime().catch((error) => {
    console.error("Failed to load Parquet viewer runtime.", error);
    showRuntimeLoadError(error instanceof Error ? error.message : String(error));
    throw error;
  });
})();
