import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 在 React 渲染前应用主题，避免首帧闪烁。
// 注意：Tauri CSP 为 script-src 'self'，禁止 index.html 内联脚本，故放在此模块中。
(() => {
  try {
    const saved = localStorage.getItem("cgx-theme") || "system";
    const dark = saved === "dark" || (saved === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    /* ignore */
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
