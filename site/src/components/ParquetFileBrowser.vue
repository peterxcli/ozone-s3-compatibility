<script setup lang="ts">
import { computed, reactive, watch } from "vue";

import ParquetGraphNode from "./ParquetGraphNode.vue";
import { buildParquetFileTree } from "../lib/parquetFiles";
import type { ParquetFileRecord, ParquetFileTreeNode } from "../lib/parquetFiles";

const props = withDefaults(
  defineProps<{
    files: ParquetFileRecord[];
    graph: ParquetFileTreeNode[];
    loading?: boolean;
    error?: string;
    selectedPath?: string;
  }>(),
  {
    graph: () => [],
    loading: false,
    error: "",
    selectedPath: "",
  },
);

const emit = defineEmits<{
  select: [file: ParquetFileRecord];
  retry: [];
}>();

const openFolders = reactive<Record<string, boolean>>({});
const tree = computed<ParquetFileTreeNode[]>(() => (props.graph.length ? props.graph : buildParquetFileTree(props.files)));
const fileCount = computed(() => props.files.length);

watch(
  tree,
  (nodes) => {
    const visit = (entries: ParquetFileTreeNode[]) => {
      entries.forEach((node) => {
        if (!node.file && openFolders[node.path] === undefined) {
          openFolders[node.path] = true;
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
    <div v-else class="parquet-graph" role="tree" aria-label="Published Parquet file hierarchy">
      <div class="parquet-graph-root">
        <div class="parquet-graph-children root-children" role="group">
          <ParquetGraphNode
            v-for="node in tree"
            :key="node.id"
            :node="node"
            :open-folders="openFolders"
            :selected-path="selectedPath"
            @select="emit('select', $event)"
            @toggle="toggleNode"
          />
        </div>
      </div>
    </div>
  </div>
</template>
