import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { rpc } from "./api";
import { supabase } from "./supabase";
import { Skeleton } from "./ui";
const demoImages = new Map<string, string>();
export async function uploadInlineImage(
  company: string,
  file: File,
  demo: boolean,
) {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size === 0 ||
    file.size > 5242880
  )
    throw Error("Use uma imagem JPG, PNG ou WebP de até 5 MB.");
  if (demo) {
    const id = crypto.randomUUID();
    demoImages.set(id, URL.createObjectURL(file));
    return id;
  }
  const record = await rpc("prepare_inline_image", {
    p_company: company,
    p_name: file.name,
    p_size: file.size,
  });
  const { error } = await supabase!.storage
    .from("mavi-inline-images")
    .upload(record.path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return record.id as string;
}
export function InlineImage({
  id,
  alt = "Imagem anexada",
}: {
  id: string;
  alt?: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true,
      objectUrl = "";
    setUrl("");
    setError(false);
    if (demoImages.has(id)) {
      setUrl(demoImages.get(id)!);
      return;
    }
    async function load() {
      if (!supabase) throw Error("Imagem indisponível");
      const { data, error } = await supabase
        .from("inline_images")
        .select("path")
        .eq("id", id)
        .single();
      if (error) throw error;
      const result = await supabase.storage
        .from("mavi-inline-images")
        .download(data.path);
      if (result.error) throw result.error;
      if (alive) {
        objectUrl = URL.createObjectURL(result.data);
        setUrl(objectUrl);
      }
    }
    void load().catch(() => {
      if (alive) setError(true);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return error ? (
    <span className="inline-image-error" role="status">
      <ImageOff size={18} />
      Imagem indisponível ou sem permissão.
    </span>
  ) : url ? (
    <img className="inline-image" src={url} alt={alt} loading="lazy" />
  ) : (
    <span role="status" aria-label="Carregando imagem">
      <Skeleton className="skeleton-inline-image" />
    </span>
  );
}
