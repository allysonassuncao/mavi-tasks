import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Layers, Merge } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty, Modal } from "./components";
import type { Snapshot } from "./types";
import type { FormPreset } from "./forms";
import { RadarItemPanel, SeverityDot } from "./RadarItemPanel";
import {
  dateBr,
  loadTheme,
  loadThemes,
  mergeThemes,
  setItemTheme,
  statusOf,
  updateTheme,
  type RadarTheme,
  type RadarThemeDetail,
  type RadarThemeFilters,
  type TopicCounts,
} from "./radar";

const ALL = "__all__";
const PAGE = 50;

/**
 * Radar › Temas: o mesmo assunto em clientes diferentes do mesmo produto,
 * do tema que mais clientes tem para o que menos tem. A MAVI agrupa os itens
 * novos; o gestor abre o tema para renomear, juntar com outro e mover itens.
 */
export function RadarThemes({
  company,
  topic,
  data,
  user,
  onNewTask,
  notify,
  onShowItems,
  onChanged,
}: {
  company: string;
  topic: TopicCounts;
  data: Snapshot;
  user: string;
  onNewTask?: (preset: FormPreset) => void;
  notify: (message: string) => void;
  /** Mostra os itens de um tema (ou "none", os sem tema) na lista de itens. */
  onShowItems: (theme: string, label: string) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [product, setProduct] = useState(ALL);
  const [days, setDays] = useState(ALL);
  const [openOnly, setOpenOnly] = useState(true);
  const [sort, setSort] = useState<NonNullable<RadarThemeFilters["sort"]>>("clients");
  const [themes, setThemes] = useState<RadarTheme[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [without, setWithout] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    (offset = 0) => {
      const n = ++request.current;
      setBusy(true);
      setError("");
      loadThemes(company, {
        topic: topic.id,
        ...(q ? { q } : {}),
        ...(product !== ALL ? { product } : {}),
        ...(days !== ALL ? { days: Number(days) } : {}),
        open_only: openOnly,
        sort,
        limit: PAGE,
        offset,
      })
        .then((page) => {
          if (n !== request.current) return;
          setTotal(page.total);
          setPending(page.pending);
          setWithout(page.without);
          setThemes((prev) => (offset && prev ? [...prev, ...page.themes] : page.themes));
        })
        .catch((e) => n === request.current && setError((e as Error).message))
        .finally(() => n === request.current && setBusy(false));
    },
    [company, topic.id, q, product, days, openOnly, sort],
  );
  useEffect(() => {
    setThemes(null);
    load(0);
  }, [load]);

  return (
    <>
      <div className="thermo-filters radar-filters">
        <span className="thermo-search">
          <Input
            type="search"
            aria-label="Buscar tema"
            placeholder="Buscar no nome ou no resumo do tema"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <span className="thermo-filter">
          <Select aria-label="Produto" value={product} onValueChange={setProduct}>
            <SelectOption value={ALL}>Todos os produtos</SelectOption>
            <SelectOption value="none">Geral / Agência</SelectOption>
            {data.products.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.name}
              </SelectOption>
            ))}
          </Select>
        </span>
        <span className="thermo-filter">
          <Select aria-label="Período" value={days} onValueChange={setDays}>
            <SelectOption value={ALL}>Qualquer data</SelectOption>
            <SelectOption value="7">Itens vistos nos últimos 7 dias</SelectOption>
            <SelectOption value="30">Itens vistos nos últimos 30 dias</SelectOption>
            <SelectOption value="90">Itens vistos nos últimos 90 dias</SelectOption>
          </Select>
        </span>
        <span className="thermo-filter">
          <Select
            aria-label="Ordenar"
            value={sort}
            onValueChange={(v) => setSort(v as NonNullable<RadarThemeFilters["sort"]>)}
          >
            <SelectOption value="clients">Mais clientes</SelectOption>
            <SelectOption value="items">Mais itens</SelectOption>
            <SelectOption value="mentions">Mais vezes citado</SelectOption>
            <SelectOption value="recent">Mais recentes</SelectOption>
          </Select>
        </span>
        <label className="thermo-check">
          <Checkbox checked={openOnly} onCheckedChange={(v) => setOpenOnly(v === true)} />
          Só com itens em aberto
        </label>
      </div>
      <p className="radar-caption">
        {themes ? `${total} ${total === 1 ? "tema" : "temas"}` : "Carregando…"}
        {pending > 0 && ` · ${pending} ${pending === 1 ? "item esperando" : "itens esperando"} a MAVI agrupar`}
        {without > 0 && (
          <>
            {" · "}
            <button type="button" className="text-btn" onClick={() => onShowItems("none", "Sem tema")}>
              {without} {without === 1 ? "item sem tema" : "itens sem tema"}
            </button>
          </>
        )}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!themes ? (
        <Loading variant="table" />
      ) : !themes.length ? (
        <Empty
          title="Nenhum tema com esses filtros"
          body="A MAVI junta os itens parecidos de clientes diferentes do mesmo produto. Os temas aparecem conforme os itens chegam."
        />
      ) : (
        <div className="drive-table-wrap">
          <table className="drive-table radar-table">
            <thead>
              <tr>
                <th>Tema</th>
                <th>Produto</th>
                <th className="num">Clientes</th>
                <th className="num">Em aberto</th>
                <th className="num">Vezes</th>
                {topic.severity && <th>Mais sério</th>}
                <th>Última vez</th>
              </tr>
            </thead>
            <tbody>
              {themes.map((t) => (
                <tr key={t.id} className="radar-row" onClick={() => setOpen(t.id)}>
                  <td>
                    <button
                      type="button"
                      className="radar-row-title"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(t.id);
                      }}
                    >
                      {t.title}
                    </button>
                    <small className="radar-row-client">
                      {t.client_names.join(", ")}
                      {t.clients > t.client_names.length && ` e mais ${t.clients - t.client_names.length}`}
                    </small>
                  </td>
                  <td>{t.product_name ?? <span className="muted">Geral</span>}</td>
                  <td className="num">
                    <strong>{t.clients}</strong>
                  </td>
                  <td className="num">
                    {t.open_items}
                    <small className="muted"> / {t.items}</small>
                  </td>
                  <td className="num">{t.mentions}</td>
                  {topic.severity && (
                    <td>
                      <SeverityDot topic={topic} value={t.max_severity} />
                    </td>
                  )}
                  <td>{dateBr(t.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {themes && themes.length < total && (
        <div className="radar-more">
          <Button className="btn secondary" loading={busy} onClick={() => load(themes.length)}>
            Carregar mais ({total - themes.length})
          </Button>
        </div>
      )}
      {open && (
        <RadarThemePanel
          company={company}
          themeId={open}
          data={data}
          user={user}
          onNewTask={onNewTask}
          notify={notify}
          onClose={() => setOpen(null)}
          onShowItems={onShowItems}
          onChanged={() => {
            load(0);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function RadarThemePanel({
  company,
  themeId,
  data,
  user,
  onNewTask,
  notify,
  onClose,
  onShowItems,
  onChanged,
}: {
  company: string;
  themeId: string;
  data: Snapshot;
  user: string;
  onNewTask?: (preset: FormPreset) => void;
  notify: (message: string) => void;
  onClose: () => void;
  onShowItems: (theme: string, label: string) => void;
  onChanged: () => void;
}) {
  const [theme, setTheme] = useState<RadarThemeDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [mergeWith, setMergeWith] = useState("");
  const [item, setItem] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      loadTheme(company, themeId)
        .then((t) => {
          setTheme(t);
          setTitle(t.title);
          setSummary(t.summary);
        })
        .catch((e) => setError((e as Error).message)),
    [company, themeId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (done) notify(done);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveItem(id: string, to: string) {
    await run(async () => {
      await setItemTheme(
        company,
        id,
        to === "__none__" ? { none: true } : to === "__auto__" ? { auto: true } : { theme: to },
      );
      // O último item saiu: o tema sumiu.
      if (theme && theme.items.length <= 1) onClose();
      else await reload();
    }, "Item movido.");
  }

  const topic = theme?.topic;
  return (
    <Modal title={theme?.title ?? "Tema do Radar"} onClose={onClose} wide busy={busy} className="radar-sheet">
      {!theme || !topic ? (
        error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading variant="detail" />
        )
      ) : (
        <div className="radar-detail">
          <div className="radar-detail-tags">
            <span className="radar-topic-tag" style={{ "--topic": topic.color } as CSSProperties}>
              {topic.name}
            </span>
            <span>
              <Layers size={13} aria-hidden="true" /> Tema
            </span>
            <span className="muted">· {theme.product_name ?? "Geral / Agência"}</span>
            {!theme.person_edited && <span className="muted">· nomeado pela MAVI</span>}
          </div>
          <label className="radar-detail-field wide">
            <span>Nome do tema</span>
            <Input
              value={title}
              maxLength={160}
              disabled={theme.can_edit === false}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() =>
                title.trim().length >= 3 &&
                title.trim() !== theme.title &&
                run(() => updateTheme(company, theme.id, title.trim(), summary).then(setTheme))
              }
            />
          </label>
          <label className="radar-detail-field wide">
            <span>O que os clientes dizem</span>
            <Textarea
              rows={2}
              maxLength={1000}
              disabled={theme.can_edit === false}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={() =>
                summary.trim() !== theme.summary &&
                run(() => updateTheme(company, theme.id, title.trim() || theme.title, summary.trim()).then(setTheme))
              }
            />
          </label>
          {theme.can_edit === false && (
            <p className="muted">
              Este tema também tem itens de clientes que não são das suas equipes: só um administrador ou gestor o renomeia
              ou junta com outro.
            </p>
          )}
          {theme.others.length > 0 && theme.can_edit !== false && (
            <div className="radar-detail-field wide radar-merge">
              <span>Juntar com outro tema (os itens dele vêm para este)</span>
              <div>
                <Select aria-label="Tema para juntar" value={mergeWith || "__pick__"} onValueChange={setMergeWith}>
                  <SelectOption value="__pick__" disabled>
                    Escolha o tema
                  </SelectOption>
                  {theme.others.map((o) => (
                    <SelectOption key={o.id} value={o.id}>
                      {o.title}
                    </SelectOption>
                  ))}
                </Select>
                <Button
                  className="btn secondary"
                  disabled={!mergeWith}
                  onClick={() =>
                    run(async () => {
                      const next = await mergeThemes(company, theme.id, [mergeWith]);
                      setTheme(next);
                      setMergeWith("");
                    }, "Temas juntados.")
                  }
                >
                  <Merge size={14} aria-hidden="true" /> Juntar aqui
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="radar-tasks-head">
            <h4 className="radar-occ-title">
              {theme.items.length} {theme.items.length === 1 ? "item" : "itens"} ·{" "}
              {new Set(theme.items.map((i) => i.client_id)).size} clientes
            </h4>
            <button type="button" className="text-btn" onClick={() => onShowItems(theme.id, theme.title)}>
              Ver na lista de itens
            </button>
          </div>
          <ul className="radar-theme-items">
            {theme.items.map((i) => {
              const s = statusOf(topic, i.status);
              return (
                <li key={i.id}>
                  <button type="button" className="radar-theme-item" onClick={() => setItem(i.id)}>
                    <span className="radar-status" style={{ "--status": s?.color ?? "#a3acab" } as CSSProperties}>
                      {s?.label ?? i.status}
                    </span>
                    <span className="radar-client-title">
                      <strong>{i.title}</strong>
                      <small>
                        {i.client_name} · {i.mentions} {i.mentions === 1 ? "vez" : "vezes"} · última em{" "}
                        {dateBr(i.last_seen_at)}
                        {i.theme_locked && " · escolhido por pessoa"}
                      </small>
                    </span>
                  </button>
                  <Select aria-label={`Mover ${i.title}`} value={theme.id} onValueChange={(v) => void moveItem(i.id, v)}>
                    <SelectOption value={theme.id}>Neste tema</SelectOption>
                    {theme.others.map((o) => (
                      <SelectOption key={o.id} value={o.id}>
                        {`Mover para ${o.title}`}
                      </SelectOption>
                    ))}
                    <SelectOption value="__none__">Tirar do tema</SelectOption>
                    <SelectOption value="__auto__">Deixar a MAVI escolher de novo</SelectOption>
                  </Select>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {item && (
        <RadarItemPanel
          company={company}
          itemId={item}
          members={data.members}
          data={data}
          user={user}
          onNewTask={onNewTask}
          notify={notify}
          onClose={() => setItem(null)}
          onChanged={(next) => {
            onChanged();
            // Saiu deste tema: o painel do item fecha (e o tema, se ficou vazio).
            if (next.theme_id !== themeId) {
              setItem(null);
              if (theme && theme.items.length <= 1) onClose();
              else void reload();
            } else void reload();
          }}
        />
      )}
    </Modal>
  );
}
