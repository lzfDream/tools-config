import { createApp } from "vue";
import {
  ElButton,
  ElContainer,
  ElCheckbox,
  ElCheckboxGroup,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElLoading,
  ElMain,
  ElOption,
  ElPagination,
  ElSelect,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElSwitch,
} from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./styles.css";
import { applyTheme, readTheme } from "./theme.js";

applyTheme(readTheme());
const app = createApp(App);
[ElButton, ElCheckbox, ElCheckboxGroup, ElContainer, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElForm, ElFormItem, ElIcon, ElInput, ElLoading, ElMain, ElOption, ElPagination, ElSelect, ElSwitch, ElTabPane, ElTable, ElTabs, ElTag]
  .forEach((component) => app.use(component));
app.mount("#app");
