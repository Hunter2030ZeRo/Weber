import { createApp } from "vue";
import { defineApp } from "@weber/runtime";
import App from "./App.vue";
import "./style.css";

defineApp({ title: "Vue · Weber", mount(root) {
  const app = createApp(App);
  app.mount(root);
  return () => app.unmount();
} });
