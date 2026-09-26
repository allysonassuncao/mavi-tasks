import { useEffect, useState } from "react";
import { Check, Copy, PlugZap, ShieldAlert, Unplug } from "lucide-react";
import type { OAuthGrant } from "@supabase/supabase-js";
import { Button } from "./ui";
import { supabase } from "./supabase";

type Workspace = { company_id: string; name: string; allowed: boolean };

const CLIENTS = [
  {
    key: "claude",
    label: "Claude",
    steps: [
      "Em claude.ai, abra Configurações › Conectores.",
      "Clique em Adicionar conector personalizado, dê o nome MAVI e cole o endereço acima.",
      "Clique em Conectar e permita o acesso na tela da MAVI.",
    ],
  },
  {
    key: "chatgpt",
    label: "ChatGPT",
    steps: [
      "Em chatgpt.com, abra Configurações › Apps e conectores › Avançado e ligue o modo desenvolvedor.",
      "Volte em Apps e conectores, clique em Criar, dê o nome MAVI, cole o endereço acima e escolha OAuth.",
      "Clique em Conectar e permita o acesso na tela da MAVI.",
    ],
  },
  {
    key: "code",
    label: "Claude Code",
    steps: [
      "No terminal, rode o comando abaixo.",
      "No Claude Code, digite /mcp, escolha mavi e entre com sua conta.",
    ],
    command: (url: string) => `claude mcp add --transport http mavi ${url}`,
  },
] as const;

/**
 * "Meu perfil" › Apps de IA conectados (IA do MAVI · fase 4): o endereço do
 * servidor MCP, como conectar no Claude, no ChatGPT e no Claude Code, e os
 * apps que a pessoa já permitiu — cada um pode ser desconectado aqui.
 */
export function ConnectedApps({ notify }: { notify: (m: string) => void }) {
  const url = `${window.location.origin}/api/mcp`;
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
  const [spaces, setSpaces] = useState<Workspace[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [client, setClient] = useState<(typeof CLIENTS)[number]["key"]>(
    "claude",
  );
  const [copied, setCopied] = useState("");
  const [revoking, setRevoking] = useState("");
  const [error, setError] = useState("");
  async function load() {
    if (!supabase) return;
    const [g, w] = await Promise.all([
      supabase.auth.oauth.listGrants(),
      supabase.rpc("mcp_workspaces"),
    ]);
    // Enquanto o servidor OAuth do Supabase estiver desligado, não há apps.
    if (g.error) {
      if (/disabled/i.test(g.error.message)) setDisabled(true);
      else setError(g.error.message);
    }
    setGrants(g.data ?? []);
    setSpaces((w.data ?? []) as Workspace[]);
  }
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Não foi possível copiar. Selecione o texto e copie.");
    }
  }
  async function revoke(grant: OAuthGrant) {
    if (!supabase) return;
    setRevoking(grant.client.id);
    setError("");
    const { error } = await supabase.auth.oauth.revokeGrant({
      clientId: grant.client.id,
    });
    setRevoking("");
    if (error) return setError(error.message);
    setGrants((list) => list?.filter((g) => g.client.id !== grant.client.id) ?? null);
    notify(`${grant.client.name || "App"} desconectado.`);
  }
  const allowed = spaces?.filter((s) => s.allowed) ?? [];
  const blocked = spaces?.filter((s) => !s.allowed) ?? [];
  const chosen = CLIENTS.find((c) => c.key === client)!;
  return (
    <section className="panel profile-card connected-apps">
      <div className="panel-heading">
        <div>
          <h2>
            <PlugZap size={18} /> Apps conectados à MAVI
          </h2>
          <p>
            Use a MAVI dentro do Claude, do ChatGPT e de outros apps de IA. Eles
            só consultam o que você já pode ver aqui — nada é criado, alterado
            ou apagado.
          </p>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {spaces && !allowed.length ? (
        <div className="oauth-warning">
          <ShieldAlert size={16} />
          <span>
            A MAVI em apps externos ainda não foi liberada para você. Peça a um
            administrador para liberar em Equipe e configurações.
          </span>
        </div>
      ) : (
        spaces &&
        blocked.length > 0 && (
          <p className="connected-note">
            Liberado em {allowed.map((s) => s.name).join(", ")}. Não liberado
            em {blocked.map((s) => s.name).join(", ")}.
          </p>
        )
      )}
      <div className="connected-url">
        <span>Endereço do servidor</span>
        <code>{url}</code>
        <Button
          className="btn secondary"
          onClick={() => void copy(url, "url")}
          aria-label="Copiar endereço"
        >
          {copied === "url" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "url" ? "Copiado" : "Copiar"}
        </Button>
      </div>
      <div className="connected-how">
        <div className="connected-tabs" role="tablist">
          {CLIENTS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={c.key === client}
              className={c.key === client ? "active" : ""}
              onClick={() => setClient(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <ol>
          {chosen.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {"command" in chosen && (
          <div className="connected-url">
            <code>{chosen.command(url)}</code>
            <Button
              className="btn secondary"
              onClick={() => void copy(chosen.command(url), "cmd")}
              aria-label="Copiar comando"
            >
              {copied === "cmd" ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          </div>
        )}
      </div>
      <div className="connected-list">
        <h3>Conectados</h3>
        {disabled ? (
          <p className="connected-note">
            A conexão com apps de IA ainda está sendo ativada na MAVI.
          </p>
        ) : grants === null ? (
          <p className="connected-note">Carregando…</p>
        ) : !grants.length ? (
          <p className="connected-note">Nenhum app conectado ainda.</p>
        ) : (
          <ul>
            {grants.map((g) => (
              <li key={g.client.id}>
                {g.client.logo_uri ? (
                  <img src={g.client.logo_uri} alt="" />
                ) : (
                  <PlugZap size={18} />
                )}
                <div>
                  <strong>{g.client.name || "App sem nome"}</strong>
                  <small>
                    Conectado em{" "}
                    {new Date(g.granted_at).toLocaleDateString("pt-BR")}
                  </small>
                </div>
                <Button
                  className="btn secondary"
                  loading={revoking === g.client.id}
                  onClick={() => void revoke(g)}
                >
                  <Unplug size={16} /> Desconectar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
