import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

export function createReconcileHandler(
  secret: string,
  createAdmin: () => SupabaseClient,
) {
  return async (req: Request) => {
    const reply = (status: number, body: unknown) =>
      Response.json(body, { status });
    if (secret.length < 32)
      return reply(503, { error: "Manutenção não configurada." });
    if (req.headers.get("Authorization") !== `Bearer ${secret}`)
      return reply(401, { error: "Não autorizado." });
    if (req.method !== "POST")
      return reply(405, { error: "Método não permitido." });
    try {
      const admin = createAdmin();
      const { data, error } = await admin.rpc("claim_storage_cleanup");
      if (error) throw error;
      const rows = (data ?? []) as { bucket_id: string; path: string }[];
      let removed = 0;
      for (const bucket of ["mavi-attachments", "mavi-inline-images"]) {
        const paths = rows
          .filter((r) => r.bucket_id === bucket)
          .map((r) => r.path);
        if (!paths.length) continue;
        // Never delete storage.objects with SQL: only Storage removes the blob.
        // On any failure leave tombstones for retry after the 15-minute lease.
        const { error: storageError } = await admin.storage
          .from(bucket)
          .remove(paths);
        if (storageError) throw storageError;
        const { error: completionError } = await admin.rpc(
          "complete_storage_cleanup",
          {
            p_bucket: bucket,
            p_paths: paths,
          },
        );
        if (completionError) throw completionError;
        removed += paths.length;
      }
      return reply(200, { removed, batch_limit: 100 });
    } catch {
      console.error(
        "Storage reconciliation failed; pending objects will be retried.",
      );
      return reply(500, {
        error: "Reconciliação falhou; nova tentativa ocorrerá automaticamente.",
      });
    }
  };
}
