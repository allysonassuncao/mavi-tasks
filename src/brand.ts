import { supabase } from "./supabase";
import { driveServer } from "./drive";

/**
 * Drive › cliente › Marca (migração 20261223090000_mavi_art_brand): logos,
 * fontes, cores e regras de uso do cliente. A MAVI lê daqui para montar as
 * artes (render_art) com a marca de verdade.
 */

export type BrandColor = { name: string; hex: string };
export type BrandFont = {
  file: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  role: string;
};
export type BrandFile = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
};
export type Brand = {
  client: string;
  client_name: string;
  folder: string | null;
  colors: BrandColor[];
  fonts: BrandFont[];
  notes: string;
  updated_at: string | null;
  files: BrandFile[];
};

export const BRAND_MAX_BYTES = 50 * 1024 * 1024;
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
export const BRAND_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,.ttf,.otf,.woff,.woff2,.pdf";

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase) throw Error("Supabase não configurado.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

/** A marca do cliente (null: a pessoa não atende este cliente). */
export const loadBrand = (company: string, client: string) =>
  rpc<Brand | null>("ai_brand_kit", { p_company: company, p_client: client });

export const saveBrand = (
  company: string,
  client: string,
  brand: Pick<Brand, "colors" | "fonts" | "notes">,
) =>
  rpc("save_client_brand", {
    p_company: company,
    p_client: client,
    p_colors: brand.colors,
    p_fonts: brand.fonts,
    p_notes: brand.notes,
  });

/** Os links (15 min) dos arquivos da marca, para a prévia. */
export const brandUrls = (company: string, client: string) =>
  driveServer<{ urls: Record<string, string> }>({ action: "brand-urls", company, client }).then(
    (r) => r.urls ?? {},
  );

export const deleteBrandFile = (file: string) =>
  driveServer<{ deleted: boolean }>({ action: "brand-delete", file });

/** Sobe um arquivo para a pasta da marca. */
export async function uploadBrandFile(
  company: string,
  client: string,
  file: File,
  onProgress: (fraction: number) => void,
) {
  if (!file.size || file.size > BRAND_MAX_BYTES)
    throw Error(`${file.name}: envie arquivos não vazios de até 50 MB.`);
  const type = file.type || (FONT_FILE.test(file.name) ? `font/${file.name.split(".").pop()!.toLowerCase()}` : "application/octet-stream");
  const id = await rpc<string>("prepare_brand_file", {
    p_company: company,
    p_client: client,
    p_name: file.name,
    p_size: file.size,
    p_content_type: type,
  });
  const { url, content_type } = await driveServer<{ url: string; content_type: string }>({
    action: "sign-upload",
    file: id,
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", content_type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(Error(`${file.name}: falha no envio (${xhr.status}).`));
    xhr.onerror = () => reject(Error(`${file.name}: falha de conexão no envio.`));
    xhr.send(file);
  });
  await rpc("confirm_drive_file", { p_file: id });
  return id;
}

const WEIGHTS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
];
/** Família, peso e estilo pelo nome do arquivo (a pessoa corrige se precisar). */
export function guessFont(fileName: string): Omit<BrandFont, "file" | "role"> {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  const [familyPart, ...rest] = base.split(/[-_ ](?=[A-Za-z]*(?:thin|light|regular|book|medium|bold|black|heavy|italic|oblique|normal))/i);
  const styleText = rest.join(" ") || base;
  const family = familyPart
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+(variable|vf)$/i, "")
    .trim();
  return {
    family: family || base,
    weight: WEIGHTS.find(([re]) => re.test(styleText))?.[1] ?? 400,
    style: /italic|oblique/i.test(styleText) ? "italic" : "normal",
  };
}
