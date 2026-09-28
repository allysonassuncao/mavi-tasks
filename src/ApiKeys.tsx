import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, ShieldAlert } from "lucide-react";
import { Button, Input } from "./ui";
import { Empty } from "./components";
import { rpc } from "./api";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_by_name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const date = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

/**
 * Equipe e configurações › Chaves de API: o administrador cria chaves para
 * sistemas externos (CRM, checkout, n8n…) cadastrarem clientes e vincularem
 * produtos pela API pública (/api/v1, docs/API.md). A chave aparece uma vez só.
 */
export function ApiKeysPanel(props: {
  company: string;
  isAdmin: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  if (props.demo)
    return (
      <section className="panel" id="config-api">
        <Empty
          title="Chaves de API na conta real"
          body="A demonstração não se conecta à API pública."
        />
      </section>
    );
  if (!props.isAdmin)
    return (
      <section className="panel" id="config-api">
        <Empty
          title="Exclusivo de administradores"
          body="Peça a um administrador para criar ou revogar chaves de API."
        />
      </section>
    );
  return <Keys {...props} />;
}

function Keys({
  company,
  notify,
}: {
  company: string;
  notify: (message: string) => void;
}) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `${window.location.origin}/api/v1`;

  const load = useCallback(async () => {
    setKeys((await rpc("api_keys_list", { p_company: company })) as ApiKey[]);
  }, [company]);
  useEffect(() => {
    setCreated(null);
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Não foi possível copiar. Selecione o texto e copie.");
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError("");
    try {
      const key = (await rpc("api_key_create", {
        p_company: company,
        p_name: name,
      })) as string;
      setCreated({ name: name.trim(), key });
      setName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function revoke(k: ApiKey) {
    if (
      !window.confirm(
        `Revogar a chave "${k.name}"? Os sistemas que a usam deixam de acessar a API na hora.`,
      )
    )
      return;
    setBusy(k.id);
    setError("");
    try {
      await rpc("api_key_revoke", { p_key: k.id });
      if (created && k.prefix === created.key.slice(0, 13)) setCreated(null);
      await load();
      notify(`Chave "${k.name}" revogada.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="panel connected-apps api-keys" id="config-api">
      <div className="panel-heading">
        <div>
          <h2>
            <KeyRound size={18} /> Chaves de API
          </h2>
          <p>
            Sistemas externos (CRM, checkout, automações) usam uma chave para
            cadastrar clientes e vincular produtos neste espaço. Crie uma chave
            por sistema, para poder revogar só aquela quando precisar.
          </p>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="connected-url">
        <span>Endereço da API</span>
        <code>{base}</code>
        <Button
          className="btn secondary"
          onClick={() => void copy(base, "url")}
          aria-label="Copiar endereço da API"
        >
          {copied === "url" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "url" ? "Copiado" : "Copiar"}
        </Button>
      </div>
      {created && (
        <div className="api-key-created" role="status">
          <div className="oauth-warning">
            <ShieldAlert size={16} />
            <span>
              Copie a chave <strong>{created.name}</strong> agora: por
              segurança, ela não aparece de novo. Guarde-a só no servidor do
              sistema que vai usá-la.
            </span>
          </div>
          <div className="connected-url">
            <code>{created.key}</code>
            <Button
              className="btn primary"
              onClick={() => void copy(created.key, "key")}
              aria-label="Copiar chave"
            >
              {copied === "key" ? <Check size={16} /> : <Copy size={16} />}
              {copied === "key" ? "Copiada" : "Copiar chave"}
            </Button>
          </div>
        </div>
      )}
      <form className="api-key-form" onSubmit={create}>
        <label>
          Nova chave
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            placeholder="Ex.: CRM, Checkout, n8n"
          />
        </label>
        <Button
          type="submit"
          className="btn primary"
          loading={busy === "create"}
          disabled={name.trim().length < 2}
        >
          <Plus size={16} /> Criar chave
        </Button>
      </form>
      <div className="connected-list">
        <h3>Chaves do espaço</h3>
        {keys === null ? (
          <p className="connected-note">Carregando…</p>
        ) : !keys.length ? (
          <p className="connected-note">Nenhuma chave criada ainda.</p>
        ) : (
          <ul>
            {keys.map((k) => (
              <li key={k.id} className={k.revoked_at ? "revoked" : ""}>
                <KeyRound size={18} />
                <div>
                  <strong>{k.name}</strong>
                  <small>
                    <code>{k.prefix}…</code> · criada por {k.created_by_name}{" "}
                    em {date(k.created_at)} ·{" "}
                    {k.revoked_at
                      ? `revogada em ${date(k.revoked_at)}`
                      : k.last_used_at
                        ? `último uso em ${date(k.last_used_at)}`
                        : "nunca usada"}
                  </small>
                </div>
                {!k.revoked_at && (
                  <Button
                    className="btn secondary"
                    loading={busy === k.id}
                    onClick={() => void revoke(k)}
                  >
                    Revogar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
