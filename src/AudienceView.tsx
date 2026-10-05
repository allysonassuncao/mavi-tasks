import type { ReactNode } from "react";
import { Sparkles, Users } from "lucide-react";
import type { AdsetAudience, AudienceDetailed, CustomAudience } from "./campaign-platform";
import "./audience.css";

/**
 * The audience of Meta ad sets as the Ads Manager's "Público" section shows
 * it: locations, age, gender, languages, custom audiences, the detailed
 * targeting (OR inside a group, AND between groups), the exclusions,
 * Advantage+, the placements, Meta's estimated size and Meta's own summary.
 * Used by Campanhas › Plataforma (live) and by the reports (frozen).
 */

export const audienceAge = (a: AdsetAudience["age"]) => `${a.min}–${a.plus ? "65+" : a.max}`;
const people = (n: number) => n.toLocaleString("pt-BR");

export function AudienceList({
  adsets,
  estimated,
  showName,
}: {
  adsets: AdsetAudience[];
  /** How many came with the estimate (a campaign's first ones). */
  estimated?: number;
  /** The ad set's name on each card (a campaign's several ad sets). */
  showName: boolean;
}) {
  if (!adsets.length) return <p className="muted">Nenhum conjunto de anúncios.</p>;
  return (
    <div className="aud-list">
      {adsets.map((s) => (
        <AudienceCard key={s.id} audience={s} showName={showName} />
      ))}
      {estimated !== undefined && estimated < adsets.length && (
        <p className="muted aud-note">
          O tamanho estimado e o resumo do Meta vêm só dos {estimated} primeiros
          conjuntos; abra um conjunto para ver os dele.
        </p>
      )}
    </div>
  );
}

export function AudienceCard({
  audience: s,
  showName,
}: {
  audience: AdsetAudience;
  showName: boolean;
}) {
  const p = s.placements;
  return (
    <section className="aud-card" aria-label={`Público de ${s.name}`}>
      {showName && (
        <header className="aud-head">
          <strong title={s.name}>{s.name}</strong>
          <span className={`aud-delivery ${s.delivery.tone}`}>
            <i aria-hidden="true" />
            {s.delivery.label}
          </span>
        </header>
      )}
      {s.estimate !== undefined && (
        <div className="aud-estimate">
          <Users size={16} aria-hidden="true" />
          {s.estimate ? (
            <span>
              <small>Tamanho estimado do público</small>
              <strong>
                {people(s.estimate.lower)} – {people(s.estimate.upper)}
              </strong>{" "}
              pessoas
            </span>
          ) : (
            <span className="muted">O Meta não informou o tamanho estimado deste público.</span>
          )}
        </div>
      )}
      {s.advantage.audience && (
        <p className="aud-advantage">
          <Sparkles size={14} aria-hidden="true" />
          <span>
            <strong>Público Advantage+ ligado.</strong> Idade, gênero e
            direcionamento detalhado são sugestões: o Meta pode entregar além
            delas quando achar que vai ter resultado melhor.
          </span>
        </p>
      )}
      <dl className="aud-rows">
        <Row label="Locais">
          {s.locations.included.length ? (
            <Chips
              items={s.locations.included.map((l) => ({
                text: l.name,
                tag: l.kind,
                extra: l.radius,
              }))}
            />
          ) : (
            "—"
          )}
          <small className="aud-sub">{s.locations.presence}</small>
          {s.locations.excluded.length > 0 && (
            <div className="aud-excluded">
              <small>Excluídos</small>
              <Chips
                tone="out"
                items={s.locations.excluded.map((l) => ({
                  text: l.name,
                  tag: l.kind,
                  extra: l.radius,
                }))}
              />
            </div>
          )}
        </Row>
        <Row label="Idade">
          {audienceAge(s.age)}
          {s.age.suggested && (
            <small className="aud-sub">
              Sugestão: {audienceAge({ ...s.age.suggested, plus: s.age.suggested.max >= 65 })}
            </small>
          )}
        </Row>
        <Row label="Gênero">{s.gender}</Row>
        <Row label="Idiomas">
          {!s.languages.count
            ? "Todos os idiomas"
            : s.languages.names.length
              ? s.languages.names.join(", ")
              : `${s.languages.count} ${s.languages.count === 1 ? "idioma" : "idiomas"}`}
        </Row>
        {(s.custom.included.length > 0 || s.custom.excluded.length > 0) && (
          <Row label="Públicos personalizados">
            {s.custom.included.length > 0 && <AudienceChips list={s.custom.included} />}
            {(s.advantage.custom || s.advantage.lookalike) && (
              <small className="aud-sub">
                {s.advantage.custom && s.advantage.lookalike
                  ? "O Meta pode expandir os públicos personalizados e semelhantes."
                  : s.advantage.custom
                    ? "O Meta pode expandir os públicos personalizados."
                    : "O Meta pode expandir os públicos semelhantes."}
              </small>
            )}
            {s.custom.excluded.length > 0 && (
              <div className="aud-excluded">
                <small>Excluídos</small>
                <AudienceChips list={s.custom.excluded} tone="out" />
              </div>
            )}
          </Row>
        )}
        <Row label="Direcionamento detalhado">
          {s.detailed.length ? (
            s.detailed.map((group, i) => (
              <div key={i} className="aud-group">
                <small className="aud-and">
                  {i === 0
                    ? "Inclui pessoas que correspondem a qualquer um destes"
                    : "E que também correspondem a qualquer um destes"}
                </small>
                <Detailed group={group} />
              </div>
            ))
          ) : (
            <span className="muted">Nenhum: público aberto (sem interesses ou comportamentos).</span>
          )}
          {s.advantage.detailed && (
            <small className="aud-sub">
              Direcionamento detalhado Advantage ligado: o Meta pode ir além
              destes interesses.
            </small>
          )}
          {s.excluded_detailed.length > 0 && (
            <div className="aud-excluded">
              <small>Excluir pessoas que correspondem a</small>
              <Detailed group={s.excluded_detailed} tone="out" />
            </div>
          )}
        </Row>
        <Row label="Posicionamentos">
          {p.automatic ? (
            "Posicionamentos Advantage+ (automáticos)"
          ) : (
            <>
              {p.platforms.join(", ") || "—"}
              {p.positions.map((x) => (
                <small key={x.platform} className="aud-sub">
                  {x.platform}: {x.items.join(", ")}
                </small>
              ))}
            </>
          )}
          {(p.devices.length > 0 || p.os.length > 0 || p.wifi_only) && (
            <small className="aud-sub">
              {[
                p.devices.length ? `Dispositivos: ${p.devices.join(", ")}` : "",
                p.os.length ? `Sistemas: ${p.os.join(", ")}` : "",
                p.wifi_only ? "Só com Wi-Fi" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
        </Row>
      </dl>
      {s.summary && s.summary.length > 0 && (
        <details className="aud-summary">
          <summary>Como o Meta descreve este público</summary>
          <ul>
            {s.summary.map((l, i) => (
              <li key={i}>
                {l.label && <strong>{l.label}: </strong>}
                {l.items.join(", ")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="aud-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Chips({
  items,
  tone,
}: {
  items: { text: string; tag?: string; extra?: string }[];
  tone?: "out";
}) {
  return (
    <ul className={`aud-chips ${tone ?? ""}`}>
      {items.map((c, i) => (
        <li key={`${c.text}${i}`}>
          {c.tag && <span className="aud-tag">{c.tag}</span>}
          {c.text}
          {c.extra && <span className="aud-extra">{c.extra}</span>}
        </li>
      ))}
    </ul>
  );
}

function AudienceChips({ list, tone }: { list: CustomAudience[]; tone?: "out" }) {
  return <Chips tone={tone} items={list.map((a) => ({ text: a.name, tag: a.type }))} />;
}

function Detailed({ group, tone }: { group: AudienceDetailed; tone?: "out" }) {
  return (
    <div className="aud-detailed">
      {group.map((c) => (
        <div key={c.category}>
          <small className="aud-category">{c.category}</small>
          <Chips tone={tone} items={c.items.map((text) => ({ text }))} />
        </div>
      ))}
    </div>
  );
}
