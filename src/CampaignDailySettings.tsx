import { useEffect, useMemo, useState } from "react";
import { Checkbox, Input, Select, SelectOption } from "./ui";
import { demoDaily, serverDaily, type DailySettings } from "./campaign-daily";

const HOURS = [5, 6, 7, 8, 9, 10, 11, 12];
const usd = (v: number) => `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Painel da MAVI › Campanhas › Leitura do dia: ligar, a hora a partir da
 * qual a MAVI escreve (depois da sincronização da manhã) e o teto por
 * leitura, com o gasto do mês. Salva na hora.
 */
export function CampaignDailySettings({
  company,
  demo = false,
  notify,
}: {
  company: string;
  demo?: boolean;
  notify: (message: string) => void;
}) {
  const backend = useMemo(() => (demo ? demoDaily() : serverDaily), [demo]);
  const [s, setS] = useState<DailySettings | null>(null);
  const [cap, setCap] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    backend
      .settings(company)
      .then((r) => {
        if (!live) return;
        setS(r);
        setCap(String(r.run_cap_usd));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [backend, company]);
  const save = async (patch: Partial<Pick<DailySettings, "enabled" | "hour" | "run_cap_usd">>) => {
    setSaving(true);
    setError("");
    try {
      const r = await backend.save(company, patch);
      setS(r);
      setCap(String(r.run_cap_usd));
      notify("Leitura do dia salva.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!s)
    return error ? (
      <p className="form-error" role="alert">
        Não foi possível carregar a leitura do dia: {error}
      </p>
    ) : null;
  return (
    <div className="thermo-settings cins-settings cins-daily">
      <section className="panel cins-block" aria-busy={saving}>
        <h3>Leitura do dia na lista de Campanhas</h3>
        <label className="cins-check">
          <Checkbox
            checked={s.enabled}
            disabled={saving}
            onCheckedChange={(v) => void save({ enabled: v === true })}
          />
          <span>
            <strong>A MAVI escreve uma frase por campanha ativa toda manhã</strong>
            <small>
              Ciclo × meta, ontem, hoje até agora e o que se destaca em públicos, conjuntos, anúncios e copys. Aparece
              no ícone da coluna MAVI da lista, com os insights abertos.
              {!s.insights_enabled && " Os insights da MAVI estão desligados: a leitura só roda com eles ligados."}
            </small>
          </span>
        </label>
        <div className="cins-row">
          <label>
            <span>A partir de</span>
            <Select
              value={String(s.hour)}
              onValueChange={(v) => void save({ hour: Number(v) })}
              aria-label="Hora da leitura do dia"
              disabled={saving}
            >
              {HOURS.map((h) => (
                <SelectOption key={h} value={String(h)}>
                  {h}h
                </SelectOption>
              ))}
            </Select>
            <small>A MAVI espera a sincronização da manhã de cada campanha (até 3 h depois desta hora).</small>
          </label>
          <label>
            <span>Teto por leitura (US$)</span>
            <Input
              type="number"
              min={0.02}
              max={5}
              step="0.01"
              value={cap}
              disabled={saving}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => {
                const v = Math.min(Math.max(Number(cap) || 0.02, 0.02), 5);
                if (v !== s.run_cap_usd) void save({ run_cap_usd: v });
                else setCap(String(s.run_cap_usd));
              }}
            />
            <small>Sem caber, a frase sai pelos números do MAVI (sem custo). Conta no teto do mês dos insights.</small>
          </label>
        </div>
        <p className="cins-help">
          Este mês: {s.month.reads} {s.month.reads === 1 ? "leitura" : "leituras"}, {usd(s.month.cost_usd)}. O
          modelo é o de "Leitura do dia" em Quem usa qual modelo (sem regra, o dos insights). Campanha sem
          investimento ontem nem hoje não gasta nada: a frase sai pelas regras.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
