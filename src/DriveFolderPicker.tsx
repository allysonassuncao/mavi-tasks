import { Building2, ChevronRight, Folder, HardDrive, Package } from "lucide-react";
import { contractProductLabel } from "./domain";
import type { DriveFolder, DriveLocation, Snapshot } from "./types";

// A mesma ordem do Drive (Z → A).
const byNameDesc = (a: { name: string }, b: { name: string }) =>
  b.name.localeCompare(a.name, "pt-BR", { numeric: true, sensitivity: "base" });

/** O lugar escolhido: o cliente e o produto (da pasta, quando é uma pasta). */
export function pickedPlace(at: DriveLocation, folders: Map<string, DriveFolder>) {
  const current = at.folder ? folders.get(at.folder) : undefined;
  return {
    current,
    client: current ? current.client_id : at.client,
    contract: current ? current.contract_id : at.contract,
  };
}

/**
 * Escolher um lugar no Drive navegando (raiz › clientes › produtos ›
 * pastas), com o caminho no topo. Usado ao mover itens e ao salvar um
 * arquivo da MAVI no Drive.
 */
export function DriveFolderPicker({
  data,
  folders,
  at,
  onPick,
  exclude,
  emptyText,
}: {
  data: Snapshot;
  /** As pastas que a pessoa vê, por id. */
  folders: Map<string, DriveFolder>;
  at: DriveLocation;
  onPick: (at: DriveLocation) => void;
  /** Pastas que não são destino (as que estão sendo movidas). */
  exclude?: Set<string>;
  emptyText: (here: string) => string;
}) {
  const { current, client, contract } = pickedPlace(at, folders);
  const clientName = (id?: string | null) => data.clients.find((c) => c.id === id)?.name ?? "Cliente";
  const crumbs: { label: string; to: DriveLocation }[] = [{ label: "Drive", to: {} }];
  const chain: DriveFolder[] = [];
  for (let f = current; f; f = f.parent_id ? folders.get(f.parent_id) : undefined) chain.unshift(f);
  if (client) crumbs.push({ label: clientName(client), to: { client } });
  if (contract)
    crumbs.push({ label: contractProductLabel(data, contract), to: { client: client ?? undefined, contract } });
  for (const f of chain)
    crumbs.push({
      label: f.name,
      to: { client: f.client_id ?? undefined, contract: f.contract_id ?? undefined, folder: f.id },
    });
  const atRoot = !at.client && !at.contract && !at.folder;
  const clients = atRoot ? data.clients.filter((c) => !c.archived).sort(byNameDesc) : [];
  const products =
    at.client && !at.contract && !at.folder
      ? data.contracts
          .filter((k) => k.client_id === at.client && !k.archived)
          .map((k) => ({ id: k.id, name: contractProductLabel(data, k.id) }))
          .sort(byNameDesc)
      : [];
  const subfolders = [...folders.values()]
    .filter(
      (f) =>
        !exclude?.has(f.id) &&
        (at.folder
          ? f.parent_id === at.folder
          : !f.parent_id && (f.client_id ?? undefined) === at.client && (f.contract_id ?? undefined) === at.contract),
    )
    .sort(byNameDesc);
  const here = crumbs[crumbs.length - 1].label;
  const row = (key: string, name: string, Icon: typeof Folder, to: DriveLocation) => (
    <li key={key}>
      <button type="button" className="drive-pick-folder" onClick={() => onPick(to)}>
        <Icon size={17} aria-hidden="true" />
        <span>{name}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </li>
  );
  return (
    <>
      <nav className="drive-pick-crumbs" aria-label="Destino">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
            {i === crumbs.length - 1 ? (
              <strong>
                {i === 0 && <HardDrive size={14} aria-hidden="true" />}
                {c.label}
              </strong>
            ) : (
              <button type="button" onClick={() => onPick(c.to)}>
                {i === 0 && <HardDrive size={14} aria-hidden="true" />}
                {c.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      <div className="drive-pick-list">
        <ul>
          {clients.map((c) => row(`c-${c.id}`, c.name, Building2, { client: c.id }))}
          {products.map((p) => row(`p-${p.id}`, p.name, Package, { client: at.client, contract: p.id }))}
          {subfolders.map((f) =>
            row(`f-${f.id}`, f.name, Folder, {
              client: f.client_id ?? undefined,
              contract: f.contract_id ?? undefined,
              folder: f.id,
            }),
          )}
          {!clients.length && !products.length && !subfolders.length && <li className="drive-pick-empty">{emptyText(here)}</li>}
        </ul>
      </div>
    </>
  );
}

/** O nome do lugar (o último pedaço do caminho). */
export function placeLabel(data: Snapshot, at: DriveLocation, folders: Map<string, DriveFolder>) {
  const { current, client, contract } = pickedPlace(at, folders);
  if (current) return current.name;
  if (contract) return contractProductLabel(data, contract);
  if (client) return data.clients.find((c) => c.id === client)?.name ?? "Cliente";
  return "Drive";
}
