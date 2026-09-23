/**
 * Retired. This function used to sign a GCS upload for any object path the
 * caller named. Uploads are now signed by /api/gcs/sign-upload (see
 * api/_uploads.ts), which only signs records the user just prepared. Kept as a
 * stub that refuses every request, so an old deployment cannot be revived by
 * adding a GCS_CREDENTIALS secret.
 */
export function createGcsStorageHandler(origin: string) {
  return async (req: Request) => {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": req.headers.get("origin") || origin || "*",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    return new Response(
      JSON.stringify({
        error:
          "Serviço desativado. Envios são autorizados por /api/gcs/sign-upload.",
      }),
      { status: 410, headers },
    );
  };
}
