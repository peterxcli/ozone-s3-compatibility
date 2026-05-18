<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { absoluteParquetFileUrl, parquetViewerStandaloneUrl } from "../lib/parquetFiles";
import type { ParquetFileRecord } from "../lib/parquetFiles";

const props = defineProps<{
  file: ParquetFileRecord | null;
}>();

declare global {
  interface Window {
    __dx_mainWasm?: unknown;
    __ozoneParquetViewerScriptPromise?: Promise<void>;
  }
}

const PARQUET_VIEWER_SCRIPT = "/assets/parquet-viewer-dxh4a536bbbd247c221.js";
const VIEWER_READY_TIMEOUT_MS = 20_000;
const FORM_READY_TIMEOUT_MS = 8_000;

const viewerRoot = ref<HTMLElement | null>(null);
const loadState = ref<"idle" | "loading" | "ready" | "error">("idle");
const errorMessage = ref<string>("");
const lastSubmittedUrl = ref<string>("");

const standaloneUrl = computed(() => (props.file ? parquetViewerStandaloneUrl(props.file.url) : ""));

interface HostPageState {
  location: string;
  scrollX: number;
  scrollY: number;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendViewerScript(): Promise<void> {
  if (window.__dx_mainWasm) {
    return Promise.resolve();
  }
  if (window.__ozoneParquetViewerScriptPromise) {
    return window.__ozoneParquetViewerScriptPromise;
  }

  window.__ozoneParquetViewerScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-parquet-viewer-runtime="true"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Parquet viewer runtime failed to load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.type = "module";
    script.async = true;
    script.src = PARQUET_VIEWER_SCRIPT;
    script.dataset.parquetViewerRuntime = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Parquet viewer runtime failed to load.")), { once: true });
    document.body.appendChild(script);
  });

  return window.__ozoneParquetViewerScriptPromise;
}

function waitFor<T>(
  readValue: () => T | null,
  timeoutMs: number,
  failureMessage: string,
): Promise<T> {
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

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ||
    null
  );
}

async function ensureViewerReady(): Promise<HTMLElement> {
  await nextTick();
  const root = viewerRoot.value;
  if (!root) {
    throw new Error("Parquet viewer mount point is unavailable.");
  }

  await appendViewerScript();
  await waitFor(() => (window.__dx_mainWasm ? window.__dx_mainWasm : null), VIEWER_READY_TIMEOUT_MS, "Parquet viewer WASM did not initialize.");
  return root;
}

function dispatchInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchSubmit(form: HTMLFormElement): void {
  let event: Event;
  try {
    event = new SubmitEvent("submit", { bubbles: true, cancelable: true });
  } catch {
    event = new Event("submit", { bubbles: true, cancelable: true });
  }
  form.dispatchEvent(event);
}

function dispatchFileInputValue(input: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function hostPageLocation(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function captureHostPageState(): HostPageState {
  return {
    location: hostPageLocation(),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

function restoreHostPageLocation(location: string): void {
  if (hostPageLocation() !== location) {
    window.history.replaceState(window.history.state, "", location);
  }
}

function restoreHostPageState(state: HostPageState): void {
  restoreHostPageLocation(state.location);
  if (window.scrollX !== state.scrollX || window.scrollY !== state.scrollY) {
    window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
  }
}

function scheduleHostPageStateRestore(state: HostPageState): void {
  [0, 100, 500, 1500].forEach((delayMs) => {
    window.setTimeout(() => restoreHostPageState(state), delayMs);
  });
}

async function downloadParquetFileForViewer(file: ParquetFileRecord, url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${file.name}: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return new File([blob], file.name || "file.parquet", {
    type: blob.type || "application/octet-stream",
  });
}

async function submitFileToViewer(file: File): Promise<void> {
  const root = await ensureViewerReady();
  const fileTab = buttonWithText(root, "From file");
  if (fileTab) {
    fileTab.click();
  }

  const input = await waitFor(
    () => root.querySelector<HTMLInputElement>('input[type="file"]'),
    FORM_READY_TIMEOUT_MS,
    "Parquet viewer file input did not become available.",
  );
  dispatchFileInputValue(input, file);
}

async function submitUrlToViewer(url: string): Promise<void> {
  const root = await ensureViewerReady();
  const urlTab = buttonWithText(root, "From URL");
  if (urlTab) {
    urlTab.click();
  }

  const input = await waitFor(
    () => root.querySelector<HTMLInputElement>('input[type="url"]'),
    FORM_READY_TIMEOUT_MS,
    "Parquet viewer URL input did not become available.",
  );
  dispatchInputValue(input, url);
  const form = input.closest("form");
  if (!form) {
    throw new Error("Parquet viewer URL form is unavailable.");
  }
  dispatchSubmit(form);
  lastSubmittedUrl.value = url;
}

async function loadSelectedFile(file: ParquetFileRecord | null): Promise<void> {
  if (!file) {
    loadState.value = "idle";
    errorMessage.value = "";
    return;
  }
  const absoluteUrl = absoluteParquetFileUrl(file.url);
  if (absoluteUrl === lastSubmittedUrl.value && loadState.value === "ready") {
    return;
  }
  const hostState = captureHostPageState();

  loadState.value = "loading";
  errorMessage.value = "";
  try {
    const viewerFile = await downloadParquetFileForViewer(file, absoluteUrl);
    await submitFileToViewer(viewerFile);
    lastSubmittedUrl.value = absoluteUrl;
    loadState.value = "ready";
  } catch (error) {
    loadState.value = "error";
    errorMessage.value = errorMessageOf(error);
  } finally {
    scheduleHostPageStateRestore(hostState);
  }
}

watch(
  () => props.file,
  (file) => {
    void loadSelectedFile(file);
  },
  { immediate: true },
);
</script>

<template>
  <div class="embedded-parquet-viewer">
    <div class="embedded-parquet-viewer-head">
      <div>
        <p class="eyebrow">Inspector</p>
        <h3>{{ file ? file.name : "Select a Parquet file" }}</h3>
        <p v-if="file" class="subtle mono">{{ file.path }}</p>
      </div>
      <a v-if="file" class="inline-button" :href="standaloneUrl" target="_blank" rel="noreferrer">
        Open standalone
      </a>
    </div>

    <div v-if="!file" class="loader empty-state">Choose a file from the manifest to inspect its rows, schema, and metadata.</div>
    <div v-else class="embedded-parquet-viewer-shell">
      <div v-if="loadState === 'loading'" class="embedded-viewer-status">Loading {{ file.name }}...</div>
      <div v-else-if="loadState === 'error'" class="embedded-viewer-status error">{{ errorMessage }}</div>
      <div id="main" ref="viewerRoot" class="embedded-parquet-viewer-root"></div>
    </div>
  </div>
</template>
