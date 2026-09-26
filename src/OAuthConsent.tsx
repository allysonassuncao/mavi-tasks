import { useEffect, useState } from "react";
import { Check, Eye, LogOut, PlugZap, ShieldAlert, X } from "lucide-react";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { Button, Loading } from "./ui";
import { supabase } from "./supabase";

/**
 * IA do MAVI · fase 4: a tela de permissão do OAuth (/oauth/consent).
 *
 * Quando alguém conecta o MAVI no Claude, no ChatGPT ou em outro cliente MCP,
 * o Supabase Auth manda a pessoa para cá com um authorization_id. Ela entra
 * (se ainda não entrou), vê quem está pedindo acesso e permite ou recusa; o
 * Supabase devolve a pessoa ao app com o código (ou com o erro).
 */
export function OAuthConsent() {
  const id =
    new URLSearchParams(window.location.search).get("authorization_id") ?? "";
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(
    null,
  );
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | "">("");
  useEffect(() => {
    document.title = "Conectar ao MAVI";
    if (!supabase) return setError("O login não está configurado.");
    if (!/^[\w-]{1,200}$/.test(id))
      return setError("O pedido de conexão está incompleto.");
    const auth = supabase.auth;
    let alive = true;
    void (async () => {
      const { data: session } = await auth.getSession();
      if (!session.session) {
        window.location.replace(
          `/login?retorno=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`,
        );
        return;
      }
      const { data, error } = await auth.oauth.getAuthorizationDetails(id);
      if (!alive) return;
      if (error || !data)
        return setError(
          error?.message
            ? `Não foi possível abrir o pedido: ${error.message}`
            : "O pedido de conexão expirou. Tente conectar de novo pelo app de IA.",
        );
      // Já permitido antes: volta direto para o app de IA.
      if ("redirect_url" in data) return window.location.replace(data.redirect_url);
      setDetails(data);
      const { data: spaces } = await supabase!.rpc("mcp_workspaces");
      if (alive)
        setAllowed(
          ((spaces ?? []) as { name: string; allowed: boolean }[])
            .filter((s) => s.allowed)
            .map((s) => s.name),
        );
    })().catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id]);
  async function decide(approve: boolean) {
    if (!supabase) return;
    setBusy(approve ? "approve" : "deny");
    const oauth = supabase.auth.oauth;
    const { data, error } = approve
      ? await oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (error || !data?.redirect_url) {
      setBusy("");
      return setError(error?.message ?? "Não foi possível concluir.");
    }
    window.location.assign(data.redirect_url);
  }
  async function switchAccount() {
    await supabase?.auth.signOut();
    window.location.replace(
      `/login?retorno=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`,
    );
  }
  const app = details?.client.name || "Um app de IA";
  return (
    <div className="public-file-page">
      <div className="public-file-card oauth-card">
        <span className="brand">
          <span className="brand-mark">W</span>
          <span>
            workspace<span className="brand-period">.</span>
          </span>
        </span>
        {error ? (
          <div className="public-file-error">
            <ShieldAlert size={30} />
            <h1>Conexão indisponível</h1>
            <p>{error}</p>
          </div>
        ) : details ? (
          <>
            <div className="oauth-app">
              {details.client.logo_uri ? (
                <img src={details.client.logo_uri} alt="" />
              ) : (
                <PlugZap size={22} />
              )}
              <div>
                <small>PEDIDO DE CONEXÃO</small>
                <h1>{app} quer acessar o MAVI</h1>
              </div>
            </div>
            <p>
              Entrando como <strong>{details.user.email}</strong>.{" "}
              <button
                type="button"
                className="oauth-switch"
                onClick={() => void switchAccount()}
              >
                Não é você?
              </button>
            </p>
            <ul className="oauth-scope">
              <li>
                <Eye size={16} />
                <span>
                  Consultar clientes, tarefas, gravações, arquivos do Drive,
                  Social Leads e campanhas que <strong>você já pode ver</strong>
                  .
                </span>
              </li>
              <li>
                <X size={16} />
                <span>Não cria, altera nem apaga nada.</span>
              </li>
              <li>
                <LogOut size={16} />
                <span>
                  Você desconecta quando quiser em <strong>Meu perfil</strong>.
                </span>
              </li>
            </ul>
            {allowed && !allowed.length && (
              <div className="oauth-warning">
                <ShieldAlert size={16} />
                <span>
                  A IA externa ainda não foi liberada para você. Dá para
                  conectar agora, mas as consultas só funcionam depois que um
                  administrador liberar em Equipe e configurações.
                </span>
              </div>
            )}
            <div className="public-file-actions">
              <Button
                className="btn primary"
                loading={busy === "approve"}
                disabled={!!busy}
                onClick={() => void decide(true)}
              >
                <Check size={17} /> Permitir
              </Button>
              <Button
                className="btn secondary"
                loading={busy === "deny"}
                disabled={!!busy}
                onClick={() => void decide(false)}
              >
                Recusar
              </Button>
            </div>
            {hostOf(details.client.uri) && (
              <small className="oauth-uri">{hostOf(details.client.uri)}</small>
            )}
          </>
        ) : (
          <Loading compact />
        )}
      </div>
    </div>
  );
}

function hostOf(uri: string) {
  try {
    return uri ? new URL(uri).host : "";
  } catch {
    return "";
  }
}
