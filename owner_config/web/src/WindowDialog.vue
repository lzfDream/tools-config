<script setup>
import { Close, FullScreen, ScaleToOriginal } from "@element-plus/icons-vue";
import { getCurrentInstance, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElDialog as ElementDialog } from "element-plus";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  title: { type: String, default: "" },
  showClose: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "fullscreen-change"]);
const fullscreen = ref(false);
const dialogId = `window-dialog-${getCurrentInstance().uid}`;

watch(() => props.modelValue, (open) => {
  if (!open && fullscreen.value) setFullscreen(false);
});

function setFullscreen(value) {
  fullscreen.value = value;
  emit("fullscreen-change", value);
}

function toggleFullscreen() {
  setFullscreen(!fullscreen.value);
}

function close() {
  emit("update:modelValue", false);
}

function isTopmostDialog() {
  const dialogs = [...document.querySelectorAll(".window-dialog")]
    .filter((element) => element.getClientRects().length > 0);
  const topmost = dialogs.reduce((current, candidate) => {
    if (!current) return candidate;
    const currentZIndex = Number.parseInt(getComputedStyle(current).zIndex, 10) || 0;
    const candidateZIndex = Number.parseInt(getComputedStyle(candidate).zIndex, 10) || 0;
    return candidateZIndex >= currentZIndex ? candidate : current;
  }, null);
  return topmost?.dataset.windowDialogId === dialogId;
}

function handleEscape(event) {
  if (event.key !== "Escape" || !props.modelValue || !fullscreen.value || !isTopmostDialog()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setFullscreen(false);
}

onMounted(() => window.addEventListener("keydown", handleEscape, true));
onBeforeUnmount(() => window.removeEventListener("keydown", handleEscape, true));
</script>

<template>
  <element-dialog
    v-bind="$attrs"
    class="window-dialog"
    :data-window-dialog-id="dialogId"
    :model-value="modelValue"
    :title="title"
    :fullscreen="fullscreen"
    align-center
    :show-close="false"
    :close-on-press-escape="!fullscreen"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header="{ titleId, titleClass }">
      <div class="window-dialog-header">
        <span :id="titleId" :class="[titleClass, 'window-dialog-title']">{{ title }}</span>
        <div class="window-dialog-controls">
          <el-button
            class="window-dialog-control"
            text
            :icon="fullscreen ? ScaleToOriginal : FullScreen"
            :aria-label="fullscreen ? '还原窗口' : '全屏显示'"
            :title="fullscreen ? '还原窗口' : '全屏显示'"
            @click.stop="toggleFullscreen"
          />
          <el-button
            v-if="showClose"
            class="window-dialog-control is-close"
            text
            :icon="Close"
            aria-label="关闭"
            title="关闭"
            @click.stop="close"
          />
        </div>
      </div>
    </template>

    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </element-dialog>
</template>
