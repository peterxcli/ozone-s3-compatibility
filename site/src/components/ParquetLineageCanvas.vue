<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import ParquetGraphNode from "./ParquetGraphNode.vue";
import type { ParquetFileRecord, ParquetFileTreeNode } from "../lib/parquetFiles";

const props = defineProps<{
  graph: ParquetFileTreeNode[];
  openFolders: Record<string, boolean>;
  selectedPath?: string;
}>();

const emit = defineEmits<{
  select: [file: ParquetFileRecord];
  toggle: [node: ParquetFileTreeNode];
}>();

const minZoom = 0.45;
const maxZoom = 1.7;
const zoomStep = 0.14;
const dragActivationDistance = 4;
const zoom = ref(0.82);
const pan = reactive({ x: 0, y: 0 });
const isPointerTracking = ref(false);
const isPanning = ref(false);
const suppressNextClick = ref(false);
const pointerStart = reactive({ x: 0, y: 0 });
const lastPointer = reactive({ x: 0, y: 0 });

const transformStyle = computed(() => ({
  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom.value})`,
}));
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`);

function clampZoom(value: number): number {
  return Math.min(maxZoom, Math.max(minZoom, value));
}

function zoomAroundPoint(nextZoom: number, x: number, y: number): void {
  const clamped = clampZoom(nextZoom);
  const ratio = clamped / zoom.value;
  pan.x = x - (x - pan.x) * ratio;
  pan.y = y - (y - pan.y) * ratio;
  zoom.value = clamped;
}

function zoomIn(): void {
  zoomAroundPoint(zoom.value + zoomStep, 0, 0);
}

function zoomOut(): void {
  zoomAroundPoint(zoom.value - zoomStep, 0, 0);
}

function resetView(): void {
  zoom.value = 0.82;
  pan.x = 0;
  pan.y = 0;
}

function handleWheel(event: WheelEvent): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const focusX = event.clientX - rect.left;
  const focusY = event.clientY - rect.top;
  const delta = event.deltaY > 0 ? -zoomStep : zoomStep;
  zoomAroundPoint(zoom.value + delta, focusX, focusY);
}

function handlePointerDown(event: PointerEvent): void {
  clearGraphTextSelection();
  isPointerTracking.value = true;
  isPanning.value = false;
  pointerStart.x = event.clientX;
  pointerStart.y = event.clientY;
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
}

function handlePointerMove(event: PointerEvent): void {
  if (!isPointerTracking.value) {
    return;
  }
  const totalDistance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  if (!isPanning.value && totalDistance < dragActivationDistance) {
    return;
  }
  if (!isPanning.value) {
    const currentTarget = event.currentTarget;
    if (currentTarget instanceof HTMLElement) {
      currentTarget.setPointerCapture(event.pointerId);
    }
    isPanning.value = true;
  }
  event.preventDefault();
  clearGraphTextSelection();
  pan.x += event.clientX - lastPointer.x;
  pan.y += event.clientY - lastPointer.y;
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
}

function stopPanning(event: PointerEvent): void {
  if (!isPointerTracking.value) {
    return;
  }
  const currentTarget = event.currentTarget;
  if (currentTarget instanceof HTMLElement && currentTarget.hasPointerCapture(event.pointerId)) {
    currentTarget.releasePointerCapture(event.pointerId);
  }
  const wasPanning = isPanning.value;
  isPointerTracking.value = false;
  isPanning.value = false;
  if (wasPanning) {
    suppressNextClick.value = true;
    window.setTimeout(() => {
      suppressNextClick.value = false;
    }, 0);
  }
  clearGraphTextSelection();
}

function handleGraphClick(event: MouseEvent): void {
  if (!suppressNextClick.value) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  suppressNextClick.value = false;
}

function clearGraphTextSelection(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.getSelection()?.removeAllRanges();
}
</script>

<template>
  <div class="parquet-lineage-canvas">
    <div class="parquet-lineage-toolbar" aria-label="Lineage graph controls">
      <button type="button" aria-label="Zoom out" title="Zoom out" @click="zoomOut">-</button>
      <span class="parquet-lineage-zoom">{{ zoomLabel }}</span>
      <button type="button" aria-label="Zoom in" title="Zoom in" @click="zoomIn">+</button>
      <button type="button" aria-label="Reset graph view" title="Reset graph view" @click="resetView">Fit</button>
    </div>

    <div
      class="parquet-graph"
      :class="{ 'is-panning': isPanning }"
      role="tree"
      aria-label="Published Parquet file hierarchy"
      @wheel.prevent="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="stopPanning"
      @pointercancel="stopPanning"
      @pointerleave="stopPanning"
      @click.capture="handleGraphClick"
    >
      <div class="parquet-graph-transform" :style="transformStyle">
        <div class="parquet-graph-root">
          <div class="parquet-graph-children root-children" role="group">
            <ParquetGraphNode
              v-for="node in graph"
              :key="node.id"
              :node="node"
              :open-folders="openFolders"
              :selected-path="selectedPath"
              @select="emit('select', $event)"
              @toggle="emit('toggle', $event)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
