(function () {
  const url = window.__ozoneStandaloneParquetUrl;
  const VIEWER_READY_TIMEOUT_MS = 20000;
  const FORM_READY_TIMEOUT_MS = 8000;

  if (!url) {
    return;
  }

  function errorMessageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function waitFor(readValue, timeoutMs, failureMessage) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = readValue();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(failureMessage));
          return;
        }
        window.setTimeout(check, 80);
      };
      check();
    });
  }

  function buttonWithText(root, text) {
    return Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) || null;
  }

  function dispatchFileInputValue(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fileNameFromUrl(fileUrl) {
    try {
      const pathname = new URL(fileUrl, window.location.href).pathname;
      return pathname.split("/").filter(Boolean).pop() || "file.parquet";
    } catch {
      return "file.parquet";
    }
  }

  function showStandaloneLoadError(message) {
    const root = document.getElementById("main");
    if (!root) {
      return;
    }
    const pre = document.createElement("pre");
    pre.style.cssText =
      "margin:1rem;padding:1rem;border-left:3px solid #ff6b6b;border-radius:8px;background:#fff;color:#ff6b6b;white-space:pre-wrap;";
    pre.textContent = `Failed to load Parquet file.\n${message}`;
    root.prepend(pre);
  }

  async function loadStandaloneParquetUrlAsFile() {
    const root = await waitFor(
      () => document.getElementById("main"),
      FORM_READY_TIMEOUT_MS,
      "Parquet viewer mount point did not become available.",
    );
    await waitFor(
      () => (window.__dx_mainWasm ? window.__dx_mainWasm : null),
      VIEWER_READY_TIMEOUT_MS,
      "Parquet viewer WASM did not initialize.",
    );
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const file = new File([blob], fileNameFromUrl(url), {
      type: blob.type || "application/octet-stream",
    });
    const fileTab = buttonWithText(root, "From file");
    if (fileTab) {
      fileTab.click();
    }
    const input = await waitFor(
      () => root.querySelector('input[type="file"]'),
      FORM_READY_TIMEOUT_MS,
      "Parquet viewer file input did not become available.",
    );
    dispatchFileInputValue(input, file);
  }

  window.loadStandaloneParquetUrlAsFile = loadStandaloneParquetUrlAsFile;
  loadStandaloneParquetUrlAsFile().catch((error) => {
    console.error("Failed to load standalone Parquet file.", error);
    showStandaloneLoadError(errorMessageOf(error));
  });
})();
