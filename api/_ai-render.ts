import type { PowerKit } from "./_ai-powers.js";
import { appOrigin } from "./_origin.js";

/**
 * Utilitários de desenho e de cliente usados pelas artes (_ai-art) e pelas
 * identidades visuais (_ai-identity). Ficam aqui, sem importar nenhum outro
 * módulo da MAVI, para não fechar o ciclo _ai-powers → _ai-identity →
 * _ai-art → _ai-powers: com ele, a /api/drive inteira caía ao carregar
 * ("Cannot access 'IDENTITY_PARAMS' before initialization").
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** O cliente pedido (id ou nome) entre os que a pessoa vê; sem pedido, o da conversa. */
export function resolveClient(kit: PowerKit, raw: unknown): string | { error: string } | null {
  const v = str(raw);
  const clients = kit.ctx.clients;
  if (!v) return kit.ctx.scope.client ?? null;
  if (UUID.test(v)) return clients.has(v) ? v : { error: "Cliente não encontrado (ou sem acesso)." };
  const want = fold(v);
  const all = [...clients.entries()];
  const exact = all.filter(([, name]) => fold(name) === want);
  const found = exact.length ? exact : all.filter(([, name]) => fold(name).includes(want));
  if (found.length === 1) return found[0][0];
  if (!found.length) return { error: `Não achei o cliente “${v}”. Confira com find_clients.` };
  return {
    error: `Há mais de um cliente com “${v}”: ${found
      .slice(0, 6)
      .map(([id, name]) => `${name} (${id})`)
      .join(", ")}. Mande o id.`,
  };
}

/**
 * O desenho aqui mesmo (só no computador). O caminho vai numa variável de
 * propósito: assim o empacotador da Vercel não leva o Chromium (70 MB) para a
 * função /api/drive, que atende todo o resto; lá, quem desenha é a
 * /api/render-art.
 */
export const localRenderer = (path = "./_art-render.ts"): Promise<typeof import("./_art-render.js")> =>
  import(/* @vite-ignore */ path);

/** Na produção, o endereço do app; nas prévias, o da própria implantação. */
export const renderOrigin = () =>
  process.env.ART_RENDER_ORIGIN?.replace(/\/+$/, "") ||
  (process.env.VERCEL_ENV === "production" || !process.env.VERCEL_URL
    ? appOrigin()
    : `https://${process.env.VERCEL_URL}`);
export function renderHeaders(auth: string): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return {
    "Content-Type": "application/json",
    Authorization: auth,
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
  };
}
