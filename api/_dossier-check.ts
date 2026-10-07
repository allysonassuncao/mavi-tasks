import { routeConfig, type ResolvedRoute } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import { workerRpc, type DossierCheck } from "./_copilot.js";
import { decideDossierOp, ruleRisk, type DossierAnswers } from "./_dossier-risk.js";
import { askJev, type JevQuestion } from "./_temperature.js";

/**
 * MAVI · memória por cliente, Fase 2: o Jev confere cada mudança que a rotina
 * do dossiê propõe contra o material citado e o próprio dossiê, antes de
 * qualquer pessoa ver. Entra na rotina por injeção (api/drive.ts): o
 * _temperature importa o _copilot, e o contrário viraria um ciclo.
 */

export const DOSSIER_QUESTIONS: Record<string, JevQuestion> = {
  supported: {
    type: "noul",
    instructions:
      "O material citado sustenta o item com clareza: o cliente disse, pediu, aprovou ou recusou isso (não é suposição nem fala de outra pessoa sobre outro assunto)?",
    criteria: { true: "Sim: o material sustenta", false: "Não: suposição ou o material não diz isso" },
  },
  contradicts: {
    type: "noul",
    instructions:
      "O item contradiz algum item do dossiê atual (diz o contrário ou muda uma regra) sem ser a atualização dele?",
    criteria: { true: "Sim: contradiz o dossiê", false: "Não: é coerente com o dossiê" },
  },
  elsewhere: {
    type: "noul",
    instructions:
      "O item é sobre a temperatura da relação (satisfação, humor, risco de cancelar) ou um problema em aberto que o time acompanha no Radar, em vez de algo que muda o jeito de executar as próximas entregas?",
    criteria: { true: "Sim: é do Termômetro ou do Radar", false: "Não: é sobre como entregar" },
  },
  useful: {
    type: "noul",
    instructions:
      "O item é específico deste cliente e útil para executar a próxima tarefa, sem dado pessoal sensível, senha ou fofoca?",
    criteria: { true: "Sim: específico e útil", false: "Não: genérico, inútil ou sensível" },
  },
};

const KIND: Record<string, string> = {
  prefers: "prefere",
  avoids: "não gosta",
  rule: "regra ou combinado",
  style: "tom e identidade",
  context: "contexto do negócio",
  history: "histórico",
};
/** No máximo tantas conferências por leitura (as outras vão para confirmação). */
export const MAX_CHECKS = 12;
const PARALLEL = 4;

export const checkDossierOps: DossierCheck = async (env: AiEnv, deps: AiDeps, c, material, ops) => {
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "mavi_judge_jev", { p_company: c.company_id }).catch(
    () => null,
  );
  const jev = route?.key_cipher ? routeConfig(env, route) : null;
  const active = c.items.filter((i) => !i.dismissed);
  const answers = new Map<number, DossierAnswers | null>();
  let input = 0;
  let cost = 0;
  let model = jev?.model ?? "";
  if (jev) {
    const todo = ops.flatMap((o, i) => (o.op !== "remove" ? [i] : [])).slice(0, MAX_CHECKS);
    for (let k = 0; k < todo.length; k += PARALLEL)
      await Promise.all(
        todo.slice(k, k + PARALLEL).map(async (i) => {
          const o = ops[i];
          const current = o.id ? c.items.find((x) => x.id === o.id) : undefined;
          const res = await askJev(
            jev,
            {
              cliente: c.client_name,
              mudanca: o.op === "add" ? "novo item" : "atualizar um item",
              tipo: KIND[o.kind ?? current?.kind ?? ""] ?? o.kind ?? "",
              item: o.text ?? "",
              ...(current ? { item_atual: current.text } : {}),
              material_citado: (o.docs ?? []).slice(0, 3).map((n) => {
                const d = material.docs[n];
                return d ? `${d.type} "${d.title}"${d.date ? ` (${d.date.slice(0, 10)})` : ""}: ${d.text.slice(0, 1500)}` : "";
              }),
              dossie_atual: active.filter((x) => x.id !== o.id).map((x) => `${KIND[x.kind] ?? x.kind}: ${x.text}`),
            },
            DOSSIER_QUESTIONS,
            deps.fetch,
            AbortSignal.timeout(30000),
          ).catch(() => null);
          if (!res) return answers.set(i, null);
          input += res.tokens;
          cost += res.cost;
          model = res.model || model;
          const a = res.answers ?? {};
          answers.set(i, {
            supported: a.supported?.noul,
            contradicts: a.contradicts?.noul,
            elsewhere: a.elsewhere?.noul,
            useful: a.useful?.noul,
          });
        }),
      );
  }
  return {
    ops: ops.map((o, i) => {
      const rule = ruleRisk(o, c.items);
      const v = !jev
        ? decideDossierOp(o, rule, null)
        : decideDossierOp(o, rule, answers.get(i) ?? {}, answers.get(i) !== undefined && answers.get(i) !== null);
      return {
        ...o,
        route: v.route,
        ...(v.reasons.length ? { reasons: v.reasons } : {}),
        ...(v.note ? { note: v.note } : {}),
        ...(Object.keys(v.checks).length ? { checks: v.checks } : {}),
      };
    }),
    usage: jev
      ? {
          model,
          input,
          cost: Math.round(cost * 1e6) / 1e6,
          ...(route ? { provider_id: route.provider_id, provider: route.provider } : {}),
        }
      : null,
  };
};
