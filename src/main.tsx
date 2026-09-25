import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ConnectionStatus } from "./ConnectionStatus";
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
const PublicDashboard = lazy(() =>
  import("./PublicDashboard").then((m) => ({ default: m.PublicDashboard })),
);
const publicDashboard = window.location.pathname.match(
  /^\/painel\/([0-9a-f]{64})\/?$/,
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {publicFile ? (
      <PublicFile token={publicFile[1]} />
    ) : publicFolder ? (
      <PublicFolder token={publicFolder[1]} />
    ) : publicDashboard ? (
      <Suspense fallback={null}>
        <PublicDashboard token={publicDashboard[1]} />
      </Suspense>
    ) : (
      <App />
    )}
    <ConnectionStatus />
  </React.StrictMode>,
);
