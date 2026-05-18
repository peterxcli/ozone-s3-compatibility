<script setup lang="ts">
import { computed } from "vue";

import type { ParquetFileRecord, ParquetFileTreeNode } from "../lib/parquetFiles";

defineOptions({
  name: "ParquetGraphNode",
});

const props = defineProps<{
  node: ParquetFileTreeNode;
  openFolders: Record<string, boolean>;
  selectedPath?: string;
}>();

const emit = defineEmits<{
  select: [file: ParquetFileRecord];
  toggle: [node: ParquetFileTreeNode];
}>();

const isFile = computed(() => Boolean(props.node.file));
const isOpen = computed(() => isFile.value || props.openFolders[props.node.path] !== false);
const childCount = computed(() => props.node.children.length);
const nodeKindLabel = computed(() => props.node.kindLabel || (props.node.file ? kindLabel(props.node.file) : "folder"));
const nodeMetaLabels = computed(() => {
  if (props.node.metaLabels?.length) {
    return props.node.metaLabels;
  }
  if (props.node.file) {
    return [rowCountText(props.node.file), byteSizeText(props.node.file)];
  }
  return [`${childCount.value} item${childCount.value === 1 ? "" : "s"}`];
});

function rowCountText(file: ParquetFileRecord): string {
  if (file.rowCount === null) {
    return "Rows unknown";
  }
  return `${file.rowCount.toLocaleString()} row${file.rowCount === 1 ? "" : "s"}`;
}

function byteSizeText(file: ParquetFileRecord): string {
  if (file.byteSize === null) {
    return "Size unknown";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = file.byteSize;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function kindLabel(file: ParquetFileRecord): string {
  return file.kind.replace(/_/g, " ");
}

function activateNode(): void {
  if (props.node.file) {
    emit("select", props.node.file);
    return;
  }
  emit("toggle", props.node);
}
</script>

<template>
  <div
    class="parquet-graph-node"
    :class="{
      folder: !node.file,
      file: node.file,
      group: node.kindLabel === 'group',
      open: isOpen,
      selected: node.file?.path === selectedPath,
      'collapsed-by-default': node.collapsedByDefault,
    }"
  >
    <button
      class="parquet-graph-card"
      type="button"
      role="treeitem"
      :aria-expanded="node.file ? undefined : isOpen"
      @click="activateNode"
    >
      <span class="parquet-node-kind">{{ nodeKindLabel }}</span>
      <span class="parquet-node-name mono">{{ node.label }}</span>
      <span class="parquet-node-meta">
        <span v-for="label in nodeMetaLabels" :key="label" class="pill">{{ label }}</span>
      </span>
    </button>

    <div v-if="node.children.length && isOpen" class="parquet-graph-children" role="group">
      <ParquetGraphNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :open-folders="openFolders"
        :selected-path="selectedPath"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
      />
    </div>
  </div>
</template>
