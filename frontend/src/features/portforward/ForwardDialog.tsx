import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useClusters } from "../../api/useClusters";
import { failure } from "../../api/http";
import type { ContainerInfo, ForwardOut, Provider } from "../../api/types";
import { DialogShell } from "../dock/ConfirmDialog";
import { describeQuery } from "../inspector/useDescribe";
import { useResourceDescribe } from "../inspector/useResourceDescribe";
import { ProviderBadge } from "../territories/ProviderBadge";
import { usePortForwards } from "./usePortForwards";
import c from "../dock/ConfirmDialog.module.css";
import s from "./ForwardDialog.module.css";

/** One port the object offers: the number to forward, as the describe names it. */
export interface PortChoice {
  port: number;
  /** "8080/TCP" */
  label: string;
  /** The declaring containers, or the name of the Service port. */
  hint: string | null;
}

export interface ForwardTarget {
  clusterId: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  /** The row's resource version: the describe (and so the port list) follows it. */
  version: string;
}

type PodPortContainer = Readonly<Pick<ContainerInfo, "name"> & { ports: readonly string[] }>;

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** A TCP port belongs to the pod even when several containers declare it. */
export function podPorts(containers: readonly PodPortContainer[], selected = ""): PortChoice[] {
  const declaring = new Map<number, Set<string>>();
  for (const container of containers) {
    if (selected && container.name !== selected) continue;
    for (const label of container.ports) {
      const port = Number(label.match(/^(\d+)\/TCP$/)?.[1]);
      if (!validPort(port)) continue;
      const names = declaring.get(port) ?? new Set<string>();
      names.add(container.name);
      declaring.set(port, names);
    }
  }
  return Array.from(declaring, ([port, names]) => ({ port, label: `${port}/TCP`, hint: [...names].join(", ") }));
}

/** The ports of a service, from the "Ports" section of its describe (columns Name, Port, ..., Protocol). */
export function servicePorts(
  sections: readonly { title: string; columns: readonly string[]; rows: readonly { text: string | null }[][] }[],
): PortChoice[] {
  const section = sections.find((x) => x.title === "Ports");
  if (!section) return [];
  const at = (column: string) => section.columns.indexOf(column);
  const out: PortChoice[] = [];
  for (const cells of section.rows) {
    const port = Number(cells[at("Port")]?.text);
    if (!Number.isInteger(port)) continue;
    const protocol = cells[at("Protocol")]?.text ?? "TCP";
    out.push({ port, label: `${port}/${protocol}`, hint: cells[at("Name")]?.text || null });
  }
  return out;
}

interface Props {
  target: ForwardTarget;
  onCancel: () => void;
  /** The forward is listening; the caller closes the dialog and says so. */
  onStarted: (forward: ForwardOut) => void;
}

/**
 * Asks which port to forward, then opens it on this computer. A start reads the cluster only, so
 * there is no diff to review; it is written to the audit log all the same. The ports are those the
 * pod's containers or the service declare, and any other number can be typed.
 */
export function ForwardDialog(props: Props) {
  // Drawn on the body: the details sit in a transformed, clipped table row, which would hold a
  // fixed dialog inside the row instead of centring it on the page.
  const { clusterId, namespace, kind, name } = props.target;
  return createPortal(
    kind === "pod" ? <PodForward key={`${clusterId}/${namespace}/${name}`} {...props} /> : <ServiceForward {...props} />,
    document.body,
  );
}

function PodForward(props: Props) {
  const { clusterId, namespace, name, version } = props.target;
  const q = useQuery(describeQuery(clusterId, namespace, name, version));
  return (
    <ForwardForm
      {...props}
      podContainers={q.isError ? null : q.data?.containers ?? null}
      portsError={q.isError ? failure(q.error) : null}
    />
  );
}

function ServiceForward(props: Props) {
  const { clusterId, namespace, name, version } = props.target;
  const q = useResourceDescribe(clusterId, "services", namespace, name, version);
  return <ForwardForm {...props} ports={q.data ? servicePorts(q.data.sections) : null} portsError={q.isError ? failure(q.error) : null} />;
}

const CUSTOM = "custom";

function ForwardForm({
  target, onCancel, onStarted, ports: serviceChoices = null, podContainers, portsError,
}: Props & { ports?: PortChoice[] | null; podContainers?: readonly PodPortContainer[] | null; portsError: string | null }) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const clusters = useClusters();
  const cluster = clusters.data?.find((x) => x.id === target.clusterId);
  const provider: Provider = cluster?.provider ?? "onprem";
  const { start } = usePortForwards();

  const [container, setContainer] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedContainer = podContainers?.some((item) => item.name === container) ? container : "";
  const ports = podContainers === undefined ? serviceChoices : podContainers && podPorts(podContainers, selectedContainer);
  // A choice from an earlier filter or describe is valid only while it remains in the current list.
  const pickedAvailable = picked !== null && (picked === CUSTOM || ports?.some((item) => String(item.port) === picked));
  const defaultChoice = ports?.length ? String(ports[0].port) : CUSTOM;
  const chosen = pickedAvailable ? picked : defaultChoice;
  const number = chosen === CUSTOM ? Number(custom) : Number(chosen);
  const valid = validPort(number) && (chosen !== CUSTOM || /^\d+$/.test(custom));

  const pickContainer = (name: string) => {
    setContainer(name);
    if (picked !== null && picked !== CUSTOM && !podPorts(podContainers ?? [], name).some((item) => String(item.port) === picked)) {
      setPicked(null);
    }
  };

  const go = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const forward = await start({
        cluster_id: target.clusterId,
        namespace: target.namespace,
        kind: target.kind,
        name: target.name,
        port: number,
      });
      onStarted(forward);
    } catch (err) {
      setError(failure(err));
      setBusy(false);
    }
  };

  const noun = target.kind;
  const where = `${cluster?.name ?? target.clusterId} / ${target.namespace} / ${target.name}`;
  return (
    <DialogShell
      provider={provider}
      role="dialog"
      busy={busy}
      onCancel={onCancel}
      first={cancelRef}
      labelledBy={`${id}-t`}
      describedBy={`${id}-b`}
      className={s.wide}
    >
      <div className={c.where}>
        <ProviderBadge provider={provider} />
        <span className={c.path}>{where}</span>
      </div>
      <h2 id={`${id}-t`} className={c.title}>Port-forward {noun} {target.name}</h2>
      <p id={`${id}-b`} className={c.body}>
        {noun === "pod"
          ? "Opens a local port that reaches a TCP port shared by the pod’s containers. The start is written to the audit log."
          : "Opens a port on this computer that reaches the service. Nothing in the cluster changes; the start is written to the audit log."}
      </p>
      {podContainers && podContainers.length > 0 && (
        <label className={s.container}>
          <span>Container</span>
          <select value={selectedContainer} disabled={busy} onChange={(e) => pickContainer(e.target.value)}>
            <option value="">All containers</option>
            {podContainers.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
      )}
      <div className={s.ports} role="radiogroup" aria-label="Port to forward">
        {ports === null && !portsError && <p className={s.note} role="status">Reading the ports…</p>}
        {portsError && <p className={s.note}>The ports couldn't be read ({portsError}). Type one below.</p>}
        {ports?.length === 0 && (
          <p className={s.note}>
            {selectedContainer ? "This container" : `This ${noun}`} declares no {noun === "pod" && "TCP "}ports. Type the one to forward below.
          </p>
        )}
        {ports?.map((p) => (
          <label key={p.port} className={s.choice} data-on={chosen === String(p.port)}>
            <input
              type="radio"
              name={`${id}-port`}
              checked={chosen === String(p.port)}
              disabled={busy}
              onChange={() => setPicked(String(p.port))}
            />
            <span className={s.num}>{p.label}</span>
            {p.hint && <span className={s.hint}>{p.hint}</span>}
          </label>
        ))}
        <label className={s.free} data-on={chosen === CUSTOM}>
          <span className={s.freeLabel}>Another port</span>
          <input
            className={s.input}
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={custom}
            disabled={busy}
            aria-invalid={chosen === CUSTOM && custom !== "" && !valid ? true : undefined}
            onFocus={() => setPicked(CUSTOM)}
            onChange={(e) => {
              setPicked(CUSTOM);
              setCustom(e.target.value);
            }}
          />
        </label>
      </div>
      {error && <p className={c.error} role="alert">{error}</p>}
      <div className={c.actions}>
        <button ref={cancelRef} type="button" className={c.btn} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`${c.btn} ${c.go}`} onClick={() => void go()} disabled={busy || !valid}>
          {busy ? "Starting…" : "Start forwarding"}
        </button>
      </div>
    </DialogShell>
  );
}
