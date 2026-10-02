import { seal, unseal } from "./_google.js";
import { callRpc } from "./_drive.js";

/**
 * Anotações do cliente › trechos secretos (migração 20270226090000).
 *
 * O valor de um secreto (uma senha, um token) nunca vai para o texto da
 * anotação nem para o banco em claro: o navegador manda o valor aqui, o
 * servidor cifra (AES-256-GCM com CLIENT_NOTES_KEY) e o banco guarda só o
 * cifrado. Para mostrar ou copiar, o banco confere o acesso da pessoa (o
 * login dela vai junto), registra quem abriu e devolve o cifrado; o servidor
 * decifra e responde só para ela. A MAVI nunca passa por aqui.
 */
export type ClientNotesEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** 32 bytes; null: secretos desligados até configurar. */
  key: Buffer | null;
};
type Fetch = typeof fetch;
type Result = { status: number; body: Record<string, unknown> };

export function clientNotesEnv(
  env: Record<string, string | undefined> = process.env,
): ClientNotesEnv {
  const key = env.CLIENT_NOTES_KEY
    ? Buffer.from(env.CLIENT_NOTES_KEY, "base64")
    : null;
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    key: key && key.length === 32 ? key : null,
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Até 4 mil caracteres por valor: senhas, tokens, chaves de API. */
export const SECRET_MAX = 4000;

const fail = (status: number, error: string): Result => ({
  status,
  body: { error },
});

export async function handleClientNotes(
  body: any,
  authorization: string | null,
  env: ClientNotesEnv,
  fetchImpl: Fetch = fetch,
): Promise<Result> {
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  if (!env.key)
    return fail(
      503,
      "Os secretos ainda não estão configurados: falta a chave CLIENT_NOTES_KEY no servidor.",
    );
  const action = body?.action;
  if (action === "create") {
    const { company, client, label } = body;
    const value = typeof body.value === "string" ? body.value : "";
    if (!UUID.test(company ?? "") || !UUID.test(client ?? ""))
      return fail(400, "Cliente inválido.");
    if (!value.length) return fail(400, "Informe o valor do secreto.");
    if (value.length > SECRET_MAX)
      return fail(400, `Valor longo demais (até ${SECRET_MAX} caracteres).`);
    const r = await callRpc<{ id: string; label: string }>(
      env,
      fetchImpl,
      authorization,
      "client_note_secret_create",
      {
        p_company: company,
        p_client: client,
        p_label: typeof label === "string" ? label : "",
        p_sealed: seal(env.key, value),
      },
    );
    if (!r.ok) return fail(r.status, r.error);
    return { status: 200, body: r.data };
  }
  if (action === "open") {
    const { secret, note } = body;
    const how = body.how === "copy" ? "copy" : "view";
    if (!UUID.test(secret ?? "")) return fail(400, "Secreto inválido.");
    const r = await callRpc<{ id: string; label: string; sealed: string }>(
      env,
      fetchImpl,
      authorization,
      "client_note_secret_open",
      {
        p_secret: secret,
        p_note: UUID.test(note ?? "") ? note : null,
        p_action: how,
      },
    );
    if (!r.ok) return fail(r.status, r.error);
    let value: string;
    try {
      value = unseal(env.key, r.data.sealed);
    } catch {
      return fail(
        500,
        "Não foi possível abrir este secreto: a chave do servidor mudou.",
      );
    }
    return { status: 200, body: { id: r.data.id, label: r.data.label, value } };
  }
  return fail(400, "Ação desconhecida.");
}
