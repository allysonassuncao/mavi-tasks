import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PublicFile } from "./PublicFile";
import { PublicFolder } from "./PublicFolder";
import "./styles.css";
import { registerServiceWorker } from "./pwa";
import { guardStrayFileDrops } from "./useFileDrop";

registerServiceWorker();
guardStrayFileDrops();
// Public share links open without the app shell (and without signing in).
const publicFile = window.location.pathname.match(
  /^\/arquivo\/([0-9a-f]{64})\/?$/,
);
const publicFolder = window.location.pathname.match(
  /^\/pasta\/([0-9a-f]{64})\/?$/,
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {publicFile ? (
      <PublicFile token={publicFile[1]} />
    ) : publicFolder ? (
      <PublicFolder token={publicFolder[1]} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
