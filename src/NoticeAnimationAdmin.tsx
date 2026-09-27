import { useEffect, useMemo, useState } from "react";
import { Film, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Select, SelectOption } from "./ui";
import { MultiPick } from "./MultiPick";
import type { AiLibrary } from "./ai";
import type { AnimationAdmin, NoticesApi } from "./notices";
import type { Snapshot } from "./types";

/**
 * Painel da MAVI › Quem usa qual modelo › Animações do Mural. O
 * administrador escolhe quais modelos da biblioteca podem gerar animações
 * (para todos os administradores e gestores, ou só para certas pessoas ou
 * equipes) e se a MAVI pode consultar a base de conhecimento. Sem nenhum
 * modelo liberado, vale o modelo da funcionalidade "Animação do aviso".
 * O teto de gasto é o dos limites da aba Consumo e limites.
 */
export function NoticeAnimationAdmin({
  api,
  company,
  data,
  library,
  notify,
}: {
  api: NoticesApi;
  company: string;
  data: Snapshot;
  library: AiLibrary | null;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState<AnimationAdmin | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .animationAdmin(company)
      .then(setConfig)
      .catch((e) => setError((e as Error).message));
  }, [api, company]);
  const choices = useMemo(
    () =>
      (library?.providers ?? [])
        .filter((p) => p.active)
        .flatMap((p) =>
          p.models.map((m) => ({
            value: `${p.id}|${m.id}`,
            label: `${p.name} · ${m.label || m.id}`,
          })),
        ),
    [library],
  );
  const leaders = data.members
    .filter((m) => m.active && (m.role === "admin" || m.role === "manager"))
    .map((m) => ({ value: m.user_id, label: m.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const teams = data.teams
    .map((t) => ({ value: t.id, label: t.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  if (!config) return error ? <p className="form-error">{error}</p> : null;
  const change = (next: AnimationAdmin) => {
    setConfig(next);
    setDirty(true);
  };
  const used = new Set(config.models.map((m) => `${m.provider_id}|${m.model}`));
  const free = choices.filter((c) => !used.has(c.value));

  return (
    <section
      className="panel notice-anim-admin"
      aria-label="Animações do Mural"
    >
      <header>
        <strong>
          <Film size={15} aria-hidden="true" /> Animações do Mural
        </strong>
        <small>
          Quais modelos podem gerar a animação de um aviso, e para quem. Sem
          nenhum aqui, vale o modelo da funcionalidade “Animação do aviso”
          acima. O teto de gasto é o de Consumo e limites.
        </small>
      </header>
      <label className="checkbox-label">
        <Checkbox
          checked={config.knowledge}
          onCheckedChange={(v) => change({ ...config, knowledge: v === true })}
          disabled={busy}
        />
        A MAVI pode consultar a base de conhecimento ao criar animações (quem
        cria liga ou desliga em cada uma)
      </label>
      {config.models.length ? (
        <ul className="notice-anim-models">
          {config.models.map((m, i) => {
            const label =
              choices.find((c) => c.value === `${m.provider_id}|${m.model}`)
                ?.label ?? `${m.model} (provedor inativo)`;
            return (
              <li key={`${m.provider_id}|${m.model}`}>
                <strong>{label}</strong>
                <MultiPick
                  label={`Pessoas que usam ${label}`}
                  allLabel="Todos os líderes"
                  noun="pessoas"
                  options={leaders}
                  value={m.user_ids}
                  onChange={(user_ids) =>
                    change({
                      ...config,
                      models: config.models.map((x, j) =>
                        j === i ? { ...x, user_ids } : x,
                      ),
                    })
                  }
                  disabled={busy}
                />
                <MultiPick
                  label={`Equipes que usam ${label}`}
                  allLabel="Qualquer equipe"
                  noun="equipes"
                  options={teams}
                  value={m.team_ids}
                  onChange={(team_ids) =>
                    change({
                      ...config,
                      models: config.models.map((x, j) =>
                        j === i ? { ...x, team_ids } : x,
                      ),
                    })
                  }
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Tirar ${label}`}
                  onClick={() =>
                    change({
                      ...config,
                      models: config.models.filter((_, j) => j !== i),
                    })
                  }
                  disabled={busy}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <small>Nenhum modelo liberado: vale o da funcionalidade.</small>
      )}
      <div className="notice-anim-add">
        <Select
          key={config.models.length}
          value=""
          onValueChange={(v) => {
            if (!v) return;
            const [provider_id, model] = v.split("|");
            change({
              ...config,
              models: [
                ...config.models,
                { provider_id, model, user_ids: [], team_ids: [] },
              ],
            });
          }}
          aria-label="Liberar um modelo"
          disabled={busy || !free.length}
        >
          <SelectOption value="">
            {free.length
              ? "Liberar um modelo da biblioteca…"
              : "Cadastre modelos em Provedores e modelos"}
          </SelectOption>
          {free.map((c) => (
            <SelectOption key={c.value} value={c.value}>
              {c.label}
            </SelectOption>
          ))}
        </Select>
        <small>
          <Plus size={12} aria-hidden="true" /> Vazio em pessoas e equipes:
          todos os administradores e gestores. Administradores usam todos.
        </small>
      </div>
      {error && <p className="form-error">{error}</p>}
      {dirty && (
        <div className="form-footer">
          <Button
            className="btn primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api.setAnimationAdmin(company, config);
                setDirty(false);
                notify("Modelos das animações salvos.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Salvar
          </Button>
        </div>
      )}
    </section>
  );
}
