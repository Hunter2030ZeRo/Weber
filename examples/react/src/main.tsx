import { createRoot } from "react-dom/client";
import { defineApp } from "@weber/runtime";
import App from "./App";
import "./style.css";

defineApp({ title: "React · Weber", mount(root) {
  const app = createRoot(root);
  app.render(<App />);
  return () => app.unmount();
} });
