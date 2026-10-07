import { supabase } from "./supabase";
import { artifactSummary, type AiArtifact, type Canvas, type CanvasArtifact } from "./mavi-artifacts";

/**
 * MAVI · edição direta no canvas (migração 20270610090000_canvas_edits): a
 * versão editada vira uma mensagem da pessoa na conversa, com o documento
 * anexado (uma referência nova, ex.: D3, "ajuste de D1, editado por você").
 * A MAVI lê essa mensagem junto com a próxima pergunta e continua dela.
 */

/** A próxima referência de documento da conversa (D1, D2…). */
export function nextDocRef(artifacts: AiArtifact[]) {
  const used = artifacts.filter((a) => a.ref.startsWith("D")).map((a) => Number(a.ref.slice(1)) || 0);
  return `D${Math.max(0, ...used) + 1}`;
}

/** A versão editada, pronta para gravar (sanitizeCanvas confere de novo ao ler). */
export function editedArtifact(from: CanvasArtifact, canvas: Canvas, ref: string): CanvasArtifact {
  return {
    id: `canvas-${crypto.randomUUID()}`,
    ref,
    type: "canvas",
    canvas,
    revision_of: from.ref,
    edited: true,
  };
}

/** O que fica escrito na conversa (e a MAVI lê). */
export const editNote = (from: CanvasArtifact, to: CanvasArtifact) =>
  `Editei o ${from.ref} direto no canvas e salvei como ${to.ref} (${artifactSummary(to)}). Daqui para a frente, use o ${to.ref}.`;

export async function saveCanvasEdit(conversation: string, note: string, artifact: CanvasArtifact) {
  if (!supabase) throw Error("Supabase não configurado.");
  const { data, error } = await supabase.rpc("ai_canvas_edit", {
    p_conversation: conversation,
    p_note: note,
    p_artifact: artifact,
  });
  if (error) throw Error(error.message);
  return Number(data);
}
