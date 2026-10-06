import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, Check, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Avatar, Empty, Modal } from "./components";
import { Button, Checkbox, Input, Loading } from "./ui";
import { ColorField, PRODUCT_COLORS } from "./ColorMenu";
import { demoCs, realCs, type CsBackend, type CsSquad } from "./cs";
import type { Snapshot } from "./types";
import "./cs.css";

const roleLabel = { admin: "Administrador", manager: "Gestor", member: "Colaborador" };

/**
 * Equipe e configurações › Squads: os times de Customer Success. São
 * separados das Equipes. Administradores criam e alteram; gestores veem.
 */
export function CsSquadsPanel({
  data,
  company,
  isAdmin,
  demo,
  notify,
}: {
  data: Snapshot;
  company: string;
  isAdmin: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const [squads, setSquads] = useState<CsSquad[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<CsSquad | "new" | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => (demo ? demoCs(data) : realCs), [demo]);
  const load = useCallback(() => {
    api
      .squads(company)
      .then((list) => {
        setSquads(list);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [api, company]);
  useEffect(() => {
    load();
    let timer: number | undefined;
    const onChange = (e: Event) => {
      const scope = (e as CustomEvent).detail?.scope;
      if (scope && scope !== "squads" && scope !== "sync") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    };
    window.addEventListener("mavi:cs", onChange);
    return () => {
      window.removeEventListener("mavi:cs", onChange);
      window.clearTimeout(timer);
    };
  }, [load]);

  const person = (id: string) => data.members.find((m) => m.user_id === id);
  return (
    <section className="panel cs-squads" id="config-squads">
      <div className="panel-heading">
        <div>
          <h2>Squads</h2>
          <p>
            Os times de Customer Success, separados das Equipes. O squad de cada mês fica guardado no ciclo do
            cliente, então trocar alguém de squad não muda os meses passados.
          </p>
        </div>
        {isAdmin && (
          <Button className="btn secondary" onClick={() => setEditing("new")}>
            <Plus size={17} /> Novo squad
          </Button>
        )}
      </div>
      {error && <p className="cs-error">{error}</p>}
      {!squads && !error && <Loading compact />}
      {squads && !squads.length && (
        <Empty
          title="Nenhum squad ainda"
          body="Crie os squads com os mesmos nomes da planilha de CS (por exemplo, Primogênito e Tão Tão Perto). Os outros nomes que aparecem na planilha entram como apelidos."
        />
      )}
      {squads?.map((s) => {
        const leaders = s.members.filter((m) => m.leader);
        return (
          <div className={`team-config cs-squad ${s.archived ? "archived" : ""}`} key={s.id}>
            <span className="cs-squad-dot" style={{ background: s.color }} aria-hidden="true" />
            <div className="team-config-info">
              <strong>
                {s.name}
                {s.archived && (
                  <span className="cs-chip muted">
                    <Archive size={11} /> Arquivado
                  </span>
                )}
              </strong>
              <small>
                <ShieldCheck size={12} />
                {leaders.map((m) => person(m.user_id)?.name).filter(Boolean).join(", ") || "Sem líder"}
                {" · "}
                {s.clients === 1 ? "1 cliente ativo" : `${s.clients} clientes ativos`}
              </small>
              {!!s.aliases.length && (
                <small className="cs-squad-aliases">Na planilha também: {s.aliases.join(", ")}</small>
              )}
            </div>
            <div className="avatar-stack">
              {s.members.map((m) => (
                <Avatar
                  key={m.user_id}
                  name={person(m.user_id)?.name ?? "?"}
                  src={person(m.user_id)?.avatar_url}
                  person={m.user_id}
                  size="small"
                />
              ))}
            </div>
            {isAdmin && (
              <Button
                className="icon-btn"
                aria-label={`Editar squad ${s.name}`}
                title="Editar squad"
                onClick={() => setEditing(s)}
              >
                <Pencil size={15} />
              </Button>
            )}
          </div>
        );
      })}
      {editing && (
        <SquadForm
          api={api}
          squad={editing === "new" ? undefined : editing}
          data={data}
          company={company}
          onSaved={(list, message) => {
            setSquads(list);
            setEditing(null);
            notify(message);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function SquadForm({
  api,
  squad,
  data,
  company,
  onSaved,
  onClose,
}: {
  api: CsBackend;
  squad?: CsSquad;
  data: Snapshot;
  company: string;
  onSaved: (list: CsSquad[], message: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(squad?.name ?? "");
  const [color, setColor] = useState(squad?.color ?? PRODUCT_COLORS[0].color);
  const [aliases, setAliases] = useState((squad?.aliases ?? []).join(", "));
  const [members, setMembers] = useState<string[]>(squad?.members.map((m) => m.user_id) ?? []);
  const [leaders, setLeaders] = useState<string[]>(
    squad?.members.filter((m) => m.leader).map((m) => m.user_id) ?? [],
  );
  const [archived, setArchived] = useState(squad?.archived ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const people = data.members.filter((m) => m.active || members.includes(m.user_id));
  function toggleMember(id: string, on: boolean) {
    setMembers((list) => (on ? [...new Set([...list, id])] : list.filter((u) => u !== id)));
    if (!on) setLeaders((list) => list.filter((u) => u !== id));
  }
  function toggleLeader(id: string) {
    if (leaders.includes(id)) setLeaders((list) => list.filter((u) => u !== id));
    else {
      setLeaders((list) => [...list, id]);
      setMembers((list) => [...new Set([...list, id])]);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const list = await api.saveSquad(company, {
        id: squad?.id,
        name,
        color,
        aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
        users: members,
        leaders,
        archived,
      });
      onSaved(list, squad ? "Squad salvo." : "Squad criado.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!squad || saving) return;
    if (!window.confirm(`Excluir o squad ${squad.name}?`)) return;
    setSaving(true);
    setError("");
    try {
      onSaved(await api.deleteSquad(squad.id), "Squad excluído.");
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title={squad ? "Editar squad" : "Novo squad"} onClose={() => !saving && onClose()} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <label>
            Nome
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={60}
              placeholder="Ex.: Primogênito"
            />
          </label>
          <ColorField legend="Cor" swatches={PRODUCT_COLORS} value={color} onChange={setColor} />
          <label>
            Outros nomes na planilha
            <Input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="Ex.: Primog, 1"
              maxLength={600}
            />
            <small className="cs-hint">
              Separe por vírgula. A leitura reconhece o nome, cada apelido e qualquer texto que comece com eles
              (sem diferença de acento ou maiúscula). Números, como “1”, só valem iguais.
            </small>
          </label>
          <fieldset className="team-people">
            <legend>Pessoas do squad</legend>
            <small>Marque quem faz parte do squad e quem lidera (pode haver mais de um líder).</small>
            {people.map((m) => {
              const isMember = members.includes(m.user_id);
              const isLeader = leaders.includes(m.user_id);
              return (
                <div className={`team-person-row ${isMember ? "member" : ""}`} key={m.user_id}>
                  <label className="checkbox-label">
                    <Checkbox checked={isMember} onCheckedChange={(on) => toggleMember(m.user_id, on === true)} />
                    <span>
                      {m.name}
                      <small>{roleLabel[m.role]}</small>
                    </span>
                  </label>
                  <button
                    type="button"
                    className={`supervisor-toggle ${isLeader ? "on" : ""}`}
                    aria-pressed={isLeader}
                    aria-label={`${m.name} lidera o squad`}
                    onClick={() => toggleLeader(m.user_id)}
                  >
                    <ShieldCheck size={14} />
                    Líder
                  </button>
                </div>
              );
            })}
          </fieldset>
          {squad && (
            <label className="checkbox-label cs-archive-toggle">
              <Checkbox checked={archived} onCheckedChange={(on) => setArchived(on === true)} />
              <span>
                Arquivado
                <small>
                  Some das escolhas novas, mas continua no histórico e reconhecido na planilha (meses antigos).
                </small>
              </span>
            </label>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {squad && !squad.used && (
            <Button type="button" className="btn secondary danger cs-delete" disabled={saving} onClick={remove}>
              <Trash2 size={15} /> Excluir
            </Button>
          )}
          <Button type="button" className="btn secondary" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" loading={saving}>
            {squad ? "Salvar alterações" : "Criar squad"} <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
