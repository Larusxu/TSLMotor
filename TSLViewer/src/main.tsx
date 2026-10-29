import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyTheme, loadSettings } from "./lib/settings";
import "./styles/app.css";

// paint the stored theme before the first render so there is no dark flash
applyTheme(loadSettings().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
