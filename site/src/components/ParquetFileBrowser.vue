<script setup lang="ts">
import { computed, reactive, watch } from "vue";

import ParquetLineageCanvas from "./ParquetLineageCanvas.vue";
import { buildParquetFileTree, groupParquetLineageGraph } from "../lib/parquetFiles";
import type { ParquetFileRecord, ParquetFileTreeNode } from "../lib/parquetFiles";

const props = withDefaults(
  defineProps<{
    files: ParquetFileRecord[];
    graph: ParquetFileTreeNode[];
    loading?: boolean;
    error?: string;
    selectedPath?: string;
    collapseThreshold?: number;
  }>(),
  {
    graph: () => [],
    loading: false,
    error: "",
    selectedPath: "",
    collapseThreshold: 6,
  },
);

const emit = defineEmits<{
  select: [file: ParquetFileRecord];
  retry: [];
}>();

const openFolders = reactive<Record<string, boolean>>({});
const tree = computed<ParquetFileTreeNode[]>(() => (props.graph.length ? props.graph : buildParquetFileTree(props.files)));
const groupedTree = computed<ParquetFileTreeNode[]>(() =>
  groupParquetLineageGraph(tree.value, { threshold: props.collapseThreshold }),
);
const fileCount = computed(() => props.files.length);

watch(
  groupedTree,
  (nodes) => {
    const visit = (entries: ParquetFileTreeNode[]) => {
      entries.forEach((node) => {
        if (!node.file && openFolders[node.path] === undefined) {
          openFolders[node.path] = node.collapsedByDefault ? false : true;
        }
        visit(node.children);
      });
    };
    visit(nodes);
  },
  { immediate: true },
);

function toggleNode(node: ParquetFileTreeNode): void {
  openFolders[node.path] = openFolders[node.path] === false;
}
</script>

<template>
  <div class="parquet-browser">
    <div class="parquet-browser-head">
      <div>
        <p class="eyebrow">Catalog lineage</p>
        <h3>Published Parquet Files</h3>
      </div>
      <span class="pill">{{ fileCount }} files</span>
    </div>

    <div v-if="loading" class="loader">Loading Parquet manifest...</div>
    <div v-else-if="error" class="loader history-detail-state">
      {{ error }}
      <button class="inline-button" type="button" @click="emit('retry')">Retry</button>
    </div>
    <div v-else-if="!files.length" class="loader empty-state">No Parquet files are listed in the published manifest.</div>
    <ParquetLineageCanvas
      v-else
      :graph="groupedTree"
      :open-folders="openFolders"
      :selected-path="selectedPath"
      @select="emit('select', $event)"
      @toggle="toggleNode"
    />
  </div>
</template>
