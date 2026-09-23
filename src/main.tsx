import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PublicFile } from "./PublicFile";
import "./styles.css";
import { registerServiceWorker } from "./pwa";

registerServiceWorker();
// Public share links open without the app shell (and without signing in).
const publicFile = window.location.pathname.match(
  /^\/arquivo\/([0-9a-f]{64})\/?$/,
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {publicFile ? <PublicFile token={publicFile[1]} /> : <App />}
  </React.StrictMode>,
);
