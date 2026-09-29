import { useEffect, useState } from "react";
import { BarChart3, Check, ImageIcon, ListChecks } from "lucide-react";
import { Button, Loading } from "./ui";
import { MultiPick } from "./MultiPick";
import type { Snapshot } from "./types";
import { powersAdmin, setPower, type PowerSetting } from "./ai";
import { POWERS, type Power } from "./mavi-artifacts";
import "./mavi-artifacts.css";

const ICONS = { visuals: BarChart3, images: ImageIcon, actions: ListChecks };
const blank = (power: Power): PowerSetting => ({
  power,
  enabled: false,
  everyone: true,
  team_ids: [],
  user_ids: [],
  except_ids: [],
  updated_at: null,
  updated_by: null,
});

/**
 * Painel da MAVI › Poderes (líderes): o que a MAVI pode fazer no módulo
 * MAVI além de consultar — visualizações, imagens e ações com confirmação.
 * Cada poder vem desligado; quem lidera liga e diz quem pode usar (todos,
 * ou equipes e pessoas, com exceções). A bolinha continua só consultando.
 */
export function AiPowersPanel({
  company,
  data,
  demo,
  notify,
}: {
  company: string;
  data: Snapshot;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const [saved, setSaved] = useState<PowerSetting[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) {
      setSaved(POWERS.map((p) => blank(p.id)));
      return;
    }
    powersAdmin(company)
      .then((list) =>
        setSaved(
          POWERS.map((p) => list.find((x) => x.power === p.id) ?? blank(p.id)),
        ),
      )
      .catch((e) => setError((e as Error).message));
  }, [company, demo]);

  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!saved) return <Loading compact />;
  return (
    <div className="ai-powers">
      <section className="panel ai-route-order">
        <strong>O que a MAVI pode fazer além de consultar</strong>
        <p>
          Os poderes valem no módulo MAVI (menu lateral). A bolinha continua só
          consultando. Quem tem a MAVI desligada nos módulos da pessoa não tem
          nenhum poder. Cada chamada fica registrada em Consumo e limites ›
          Ferramentas.
        </p>
      </section>
      {saved.map((s) => (
        <PowerCard
          key={s.power}
          initial={s}
          data={data}
          onSave={async (next) => {
            if (!demo) await setPower(company, next);
            setSaved((list) =>
              list?.map((x) => (x.power === next.power ? next : x)) ?? list,
            );
            notify(
              demo
                ? "Na demonstração nada é salvo."
                : next.enabled
                  ? "Poder ligado."
                  : "Poder salvo.",
            );
          }}
        />
      ))}
    </div>
  );
}

function PowerCard({
  initial,
  data,
  onSave,
}: {
  initial: PowerSetting;
  data: Snapshot;
  onSave: (next: PowerSetting) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setForm(initial), [initial]);
  const info = POWERS.find((p) => p.id === initial.power)!;
  const Icon = ICONS[initial.power];
  const people = data.members
    .filter((m) => m.active)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((m) => ({ value: m.user_id, label: m.name }));
  const teams = [...data.teams]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((t) => ({ value: t.id, label: t.name }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (patch: Partial<PowerSetting>) =>
    setForm((f) => ({ ...f, ...patch }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`panel ai-power${form.enabled ? " on" : ""}`}>
      <header className="ai-power-head">
        <span className="ai-power-icon" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div>
          <strong>{info.label}</strong>
          <small>{info.description}</small>
          {initial.power === "images" && (
            <small>
              O modelo sai de{" "}
              <a href="#regras">Quem usa qual modelo › Geração e edição de imagens</a>
              ; sem escolha, vale o do servidor (gpt-image-1, com a chave da
              OpenAI da Vercel).
            </small>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          aria-label={`${form.enabled ? "Desligar" : "Ligar"} ${info.label}`}
          className={`template-switch${form.enabled ? " on" : ""}`}
          onClick={() => set({ enabled: !form.enabled })}
        >
          <span aria-hidden="true" />
          {form.enabled ? "Ligado" : "Desligado"}
        </button>
      </header>
      {form.enabled && (
        <div className="ai-power-audience">
          <fieldset>
            <legend>Quem pode usar</legend>
            <label>
              <input
                type="radio"
                name={`power-${initial.power}`}
                checked={form.everyone}
                onChange={() => set({ everyone: true })}
              />
              Todas as pessoas da empresa
            </label>
            <label>
              <input
                type="radio"
                name={`power-${initial.power}`}
                checked={!form.everyone}
                onChange={() => set({ everyone: false })}
              />
              Só as equipes e pessoas escolhidas
            </label>
          </fieldset>
          {!form.everyone && (
            <div className="ai-power-picks">
              <label>
                <span>Equipes</span>
                <MultiPick
                  label="Equipes"
                  allLabel="Nenhuma equipe"
                  noun="equipes"
                  options={teams}
                  value={form.team_ids}
                  onChange={(team_ids) => set({ team_ids })}
                />
              </label>
              <label>
                <span>Pessoas</span>
                <MultiPick
                  label="Pessoas"
                  allLabel="Nenhuma pessoa"
                  noun="pessoas"
                  options={people}
                  value={form.user_ids}
                  onChange={(user_ids) => set({ user_ids })}
                />
              </label>
            </div>
          )}
          <div className="ai-power-picks">
            <label>
              <span>Exceto</span>
              <MultiPick
                label="Exceto"
                allLabel="Ninguém"
                noun="pessoas"
                options={people}
                value={form.except_ids}
                onChange={(except_ids) => set({ except_ids })}
              />
            </label>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {dirty && (
        <footer className="ai-power-foot">
          <Button
            className="btn secondary"
            onClick={() => setForm(initial)}
            disabled={busy}
          >
            Descartar
          </Button>
          <Button
            className="btn primary"
            onClick={() => void save()}
            loading={busy}
          >
            <Check size={15} /> Salvar
          </Button>
        </footer>
      )}
    </section>
  );
}
