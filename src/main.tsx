import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ConnectionStatus } from "./ConnectionStatus";
import { PublicFile } from "./PublicFile";
import { PublicFolder } from "./PublicFolder";
import "./styles.css";
import "./mobile.css";
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
const PublicSocialLeads = lazy(() =>
  import("./PublicSocialLeads").then((m) => ({
    default: m.PublicSocialLeads,
  })),
);
const PublicCase = lazy(() =>
  import("./PublicCase").then((m) => ({ default: m.PublicCase })),
);
const publicCase = window.location.pathname.match(
  /^\/cases\/([0-9a-f]{64})\/?$/,
);
const PublicMeeting = lazy(() =>
  import("./PublicMeeting").then((m) => ({ default: m.PublicMeeting })),
);
const publicMeeting = window.location.pathname.match(
  /^\/gravacao\/([0-9a-f]{64})\/?$/,
);
const PublicCampaignReport = lazy(() =>
  import("./PublicCampaignReport").then((m) => ({
    default: m.PublicCampaignReport,
  })),
);
const publicReport = window.location.pathname.match(
  /^\/relatorio\/([0-9a-f]{64})\/?$/,
);
const approvalLink = window.location.pathname.match(
  /^\/aprovacao\/([0-9a-f]{64})\/?$/,
);
// IA do MAVI: a tela de permissão do OAuth (Claude, ChatGPT e outros apps MCP).
const OAuthConsent = lazy(() =>
  import("./OAuthConsent").then((m) => ({ default: m.OAuthConsent })),
);
const oauthConsent = /^\/oauth\/consent\/?$/.test(window.location.pathname);
// Documentação da API pública, aberta sem login para quem integra.
const ApiDocs = lazy(() =>
  import("./ApiDocs").then((m) => ({ default: m.ApiDocs })),
);
const apiDocs = /^\/docs\/api\/?$/.test(window.location.pathname);
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
    ) : publicCase ? (
      <Suspense fallback={null}>
        <PublicCase token={publicCase[1]} />
      </Suspense>
    ) : publicMeeting ? (
      <Suspense fallback={null}>
        <PublicMeeting token={publicMeeting[1]} />
      </Suspense>
    ) : publicReport ? (
      <Suspense fallback={null}>
        <PublicCampaignReport token={publicReport[1]} />
      </Suspense>
    ) : approvalLink ? (
      <Suspense fallback={null}>
        <PublicSocialLeads token={approvalLink[1]} />
      </Suspense>
    ) : apiDocs ? (
      <Suspense fallback={null}>
        <ApiDocs />
      </Suspense>
    ) : oauthConsent ? (
      <Suspense fallback={null}>
        <OAuthConsent />
      </Suspense>
    ) : (
      <App />
    )}
    <ConnectionStatus />
  </React.StrictMode>,
);
