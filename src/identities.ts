import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { providerAction } from "./ai";
import {
  googleFontsHref,
  lookFiles,
  type IdentityRow,
  type IdentityScope,
  type IdentityTokens,
  type Look,
} from "./visual-identity";

/**
 * Identidades visuais (migração 20270604090000_visual_identities): a do
 * cliente fica em Drive › cliente › Marca (o Guia da marca), a da empresa e a
 * galeria em MAVI › Identidades. Qualquer pessoa da empresa edita a da
 * empresa e a galeria; a do cliente, quem atende o cliente.
 */

export type IdentityVersion = { version: number; reason: string; created_at: string; author_name: string | null };
export type IdentityFull = IdentityRow & { guide: string; archived: boolean; versions: IdentityVersion[] };
export type IdentityList = { company: IdentityRow | null; client: IdentityRow | null; gallery: IdentityRow[] };

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase) throw Error("Supabase não configurado.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

export const listIdentities = (company: string, client: string | null = null) =>
  rpc<IdentityList | null>("identity_list", { p_company: company, p_client: client }).then(
    (r) => r ?? { company: null, client: null, gallery: [] },
  );
export const getIdentity = (id: string) => rpc<IdentityFull | null>("identity_get", { p_id: id });
export const clientIdentity = (company: string, client: string) =>
  rpc<IdentityFull | null>("identity_of_client", { p_company: company, p_client: client });
export const identityVersion = (id: string, version: number) =>
  rpc<{ version: number; name: string; description: string; tokens: unknown; guide: string; reason: string } | null>(
    "identity_version",
    { p_id: id, p_version: version },
  );
export const saveIdentity = (
  company: string,
  draft: {
    id: string | null;
    scope: IdentityScope;
    client: string | null;
    name: string;
    description: string;
    tokens: IdentityTokens;
    guide: string;
    reason?: string;
  },
) =>
  rpc<{ id: string; version: number }>("identity_save", {
    p_company: company,
    p_id: draft.id,
    p_scope: draft.scope,
    p_client: draft.client,
    p_name: draft.name,
    p_description: draft.description,
    p_tokens: draft.tokens,
    p_guide: draft.guide,
    p_reason: draft.reason ?? "",
  });
export const restoreIdentity = (id: string, version: number) =>
  rpc<{ id: string; version: number }>("identity_restore", { p_id: id, p_version: version });
export const archiveIdentity = (id: string) => rpc("identity_archive", { p_id: id });

/** Os links (15 min) dos logos e das fontes da Marca usados no tema. */
export const identityFileUrls = (company: string, files: string[]) =>
  files.length
    ? providerAction<{ urls: Record<string, string> }>({ action: "ai-identity-files", company, files }).then(
        (r) => r.urls ?? {},
      )
    : Promise.resolve({} as Record<string, string>);

/**
 * "Gerar com a MAVI": um rascunho da identidade (tema e Guia da marca) a
 * partir da Marca, do site e do que a pessoa pediu. Nada é gravado: a tela
 * abre no editor.
 */
export const draftIdentity = (
  company: string,
  input: { scope: IdentityScope; client?: string | null; url?: string; notes?: string; current?: string | null },
) =>
  providerAction<{ name: string; description: string; tokens: IdentityTokens; guide: string; notes: string[]; model: string }>({
    action: "ai-identity-draft",
    company,
    ...input,
  });

/** As páginas do design livre em imagem, para o PowerPoint (links de 15 min). */
export const canvasPages = (company: string, html: string, files: string[], images: Record<string, string>, format: string) =>
  providerAction<{ urls: string[]; width: number; height: number }>({
    action: "ai-canvas-pages",
    company,
    html,
    files,
    images,
    format,
  });

/** O PDF do documento, gerado no servidor (link de 15 min). */
export const canvasPdf = (company: string, html: string, files: string[], images: Record<string, string>) =>
  providerAction<{ url: string }>({ action: "ai-canvas-pdf", company, html, files, images }).then((r) => r.url);

// ------------------------------------------------------------ fontes na tela
const loaded = new Set<string>();
/** Põe a folha do Google Fonts na página (uma vez por endereço). */
function googleFonts(href: string | null) {
  if (!href || loaded.has(href) || typeof document === "undefined") return;
  loaded.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
/** As fontes da marca (arquivos) registradas na página, para o shadow DOM usar. */
function brandFonts(look: Pick<Look, "faces">, urls: Record<string, string>) {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  for (const f of look.faces) {
    const url = urls[f.file];
    const key = `${f.family}|${f.weight}|${f.style}|${f.file}`;
    if (!url || loaded.has(key)) continue;
    loaded.add(key);
    const face = new FontFace(f.family, `url("${url}")`, { weight: String(f.weight), style: f.style });
    document.fonts.add(face);
    void face.load().catch(() => loaded.delete(key));
  }
}

/**
 * Os links dos arquivos do tema e as fontes carregadas na página. Devolve a
 * troca das referências (file:<id>) para o desenho da tela.
 */
export function useLookAssets(company: string, look: Look | null | undefined, extra: string[] = []) {
  const extraKey = extra.join(",");
  const files = useMemo(
    () => [...new Set([...(look ? lookFiles(look) : []), ...(extraKey ? extraKey.split(",") : [])])],
    [look, extraKey],
  );
  const key = files.join(",");
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!look) return;
    googleFonts(googleFontsHref(look));
  }, [look]);
  useEffect(() => {
    let live = true;
    if (!key) return;
    identityFileUrls(company, key.split(","))
      .then((u) => {
        if (!live) return;
        setUrls(u);
        if (look) brandFonts(look, u);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, key]);
  return urls;
}

/** Baixa um link como data: (para o .html sair com tudo dentro). */
export async function dataUrl(url: string) {
  const blob = await (await fetch(url)).blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
