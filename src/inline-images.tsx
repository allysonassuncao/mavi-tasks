import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { rpc } from "./api";
import { supabase } from "./supabase";
import { uploadToGcs, getGcsPublicUrl } from "./gcs";
import { inlineImageTypes } from "./upload-types";
import { Skeleton } from "./ui";
import { FileViewer, downloadUrl } from "./FileViewer";

const demoImages = new Map<string, string>();

export async function uploadInlineImage(
  company: string,
  file: File,
  demo: boolean,
) {
  if (
    !inlineImageTypes.includes(file.type) ||
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
  await uploadToGcs({ kind: "inline-image", id: record.id }, file, file.type);
  return record.id as string;
}

export function InlineImage({
  id,
  alt = "Imagem anexada",
  zoomable = false,
}: {
  id: string;
  alt?: string;
  /** Opens the image in the file viewer on click (not inside the editor). */
  zoomable?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl("");
    setError(false);

    if (demoImages.has(id)) {
      setUrl(demoImages.get(id)!);
      return;
    }

    async function load() {
      if (!supabase) throw Error("Imagem indisponível");
      const { data, error: fetchError } = await supabase
        .from("inline_images")
        .select("path")
        .eq("id", id)
        .single();
      if (fetchError) throw fetchError;
      if (alive && data?.path) {
        setUrl(getGcsPublicUrl(data.path));
      }
    }

    void load().catch(() => {
      if (alive) setError(true);
    });

    return () => {
      alive = false;
    };
  }, [id]);

  return error ? (
    <span className="inline-image-error" role="status">
      <ImageOff size={18} />
      Imagem indisponível ou sem permissão.
    </span>
  ) : url && zoomable ? (
    <>
      <button
        type="button"
        className="inline-image-zoom"
        title="Ampliar imagem"
        aria-label={`Ampliar ${alt}`}
        onClick={() => setOpen(true)}
      >
        <img
          className="inline-image"
          src={url}
          alt={alt}
          loading="lazy"
          onError={() => setError(true)}
        />
      </button>
      {open && (
        <FileViewer
          files={[
            {
              key: id,
              name: alt,
              contentType: "image/*",
              load: async () => url,
              download: () => downloadUrl(url, alt),
              openOriginal: () => window.open(url, "_blank", "noopener"),
            },
          ]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  ) : url ? (
    <img
      className="inline-image"
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setError(true)}
    />
  ) : (
    <span role="status" aria-label="Carregando imagem">
      <Skeleton className="skeleton-inline-image" />
    </span>
  );
}
