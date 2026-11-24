// The files for tools on a Docker host or on servers, then the wait for them to answer. OmniKrux
// writes the file (nothing is stored or audited), the user runs it, and the tools are probed at the
// addresses the file gave them until each one answers. "The tools answer" is said only after a
// probe said so. Nothing here keeps a secret: the generated tools have no sign-in to keep.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { failure } from "../../api/http";
import { generateFiles, type GeneratedFile, type GeneratedOut, type ProbeResultOut, type ToolType } from "./api";
import s from "./GenerateTools.module.css";
import { allAnswer, useToolsProbe } from "./useToolsProbe";

export type AnsweredTools = { type: ToolType; url: string; version: string | null }[];

type Kind = "docker" | "servers";

const WORDS: Record<Kind, { heading: string; lead: string; address: string; placeholder: string; write: string }> = {
  docker: {
    heading: "Install the tools on the Docker host",
    lead: "OmniKrux writes a docker-compose file for Prometheus, Alertmanager, node-exporter, Loki and Grafana Alloy. You run it on the host; OmniKrux never needs SSH or the Docker socket.",
    address: "Address OmniKrux will reach them at",
    placeholder: "docker-host.example",
    write: "Write the file",
  },
  servers: {
    heading: "Install the tools on your servers",
    lead: "OmniKrux writes a script that installs Prometheus, Alertmanager, node-exporter, Loki and Grafana Alloy as systemd services. You run it on your servers; OmniKrux never needs SSH keys.",
    address: "Address OmniKrux will reach them at",
    placeholder: "monitor-1.example",
    write: "Write the script",
  },
};

/** The backend's words for each field (`install/messages.py`), to show a refusal under its field. */
const ADDRESS_WORDS = "Use a host name or IP address, without http:// or a port.";
const RETENTION_WORDS = "Keep data for 1 to 90 days.";
const SERVERS_WORDS = "Use one host or host:port per line.";

const TOOL_LABEL: Record<ToolType, string> = { prometheus: "Prometheus", alertmanager: "Alertmanager", loki: "Loki" };
const ORDER: ToolType[] = ["prometheus", "alertmanager", "loki"];

export const WAITING = "Waiting for the tools to answer…";
export const GAVE_UP = "Still waiting. Check that the tools are running and the ports are open, then wait again.";
export const STOPPED = "Stopped waiting for the tools.";
export const ANSWERED = "The tools answer. They're added to this project's sources.";
export const COPIED = "Copied.";
export const NOT_COPIED = "Couldn't copy. Select the text and copy it yourself.";

const ports = (list: number[]): string =>
  list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

/** A Blob download of the file's text; the object URL is released at once. */
function download(file: GeneratedFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Instructions({ kind, file, address, portList }: { kind: Kind; file: GeneratedFile; address: string; portList: number[] }) {
  const reach = (where: string) => (
    <li className={s.warn}>
      Make sure ports {ports(portList)}{where} are reachable from OmniKrux, and from nowhere else: the tools have no sign-in.
    </li>
  );
  return kind === "docker" ? (
    <ol className={s.steps} aria-label="What to do next">
      <li>Copy <code>{file.name}</code> to the Docker host.</li>
      <li>In its folder, run <code>docker compose up -d</code>.</li>
      {reach("")}
    </ol>
  ) : (
    <ol className={s.steps} aria-label="What to do next">
      <li>On the server that keeps the data ({address}), run <code>sudo bash omnikrux-monitoring.sh --role central</code>.</li>
      <li>On every other server, run <code>sudo bash omnikrux-monitoring.sh --role agent --central {address}</code>.</li>
      {reach(` on ${address}`)}
      <li>To remove them later, run the script with <code>--uninstall</code>.</li>
    </ol>
  );
}

function Field({ id, label, error, children }: { id: string; label: ReactNode; error: string | null; children: ReactNode }) {
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <p id={`${id}-err`} className={s.problem} role="alert">{error}</p>}
    </div>
  );
}

function Waiting({ urls, results, waiting, answered, gaveUp, onStop, onAgain, again, status }: {
  urls: Partial<Record<ToolType, string>>; results: ProbeResultOut[]; waiting: boolean; gaveUp: boolean; answered: boolean;
  onStop(): void; onAgain(): void; again: RefObject<HTMLButtonElement | null>; status: RefObject<HTMLDivElement | null>;
}) {
  const by = new Map(results.map((r) => [r.type, r]));
  const message = answered ? ANSWERED : waiting ? WAITING : gaveUp ? GAVE_UP : STOPPED;
  return (
    <div ref={status} className={s.waiting} tabIndex={-1} role="status" data-state={answered ? "answered" : waiting ? "waiting" : "ended"}>
      <p className={s.waitLine}>{message}</p>
      <ul className={s.tools}>
        {ORDER.filter((t) => urls[t]).map((t) => {
          const r = by.get(t);
          const up = r?.ok === true;
          const version = r?.version ? ` · v${r.version.replace(/^v/, "")}` : "";
          return (
            <li key={t} className={s.tool}>
              <span className={s.toolName}>{TOOL_LABEL[t]} · {urls[t]}</span>
              <span className={s.chip} data-tone={up ? "ok" : "plain"}>{up ? `Answering${version}` : "Not answering yet"}</span>
            </li>
          );
        })}
      </ul>
      {waiting && <button type="button" className={s.quiet} onClick={onStop}>Stop waiting</button>}
      {!waiting && !answered && <button ref={again} type="button" className={s.secondary} onClick={onAgain}>Wait again</button>}
    </div>
  );
}

export function GenerateTools({ kind, onAnswered }: { kind: Kind; onAnswered(tools: AnsweredTools): void | Promise<void> }) {
  const words = WORDS[kind];
  const ids = useId();
  const [address, setAddress] = useState("");
  const [days, setDays] = useState("7");
  const [servers, setServers] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ address?: string; days?: string; servers?: string; form?: string }>({});
  const [made, setMade] = useState<{ out: GeneratedOut; address: string } | null>(null);
  const [said, setSaid] = useState("");
  const addressInput = useRef<HTMLInputElement>(null);
  const daysInput = useRef<HTMLInputElement>(null);
  const serversInput = useRef<HTMLTextAreaElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const writing = useRef(false);

  const probe = useToolsProbe(made ? made.out.urls : null);
  const file = made?.out.files[0] ?? null;
  const count = made ? Object.keys(made.out.urls).length : 0;
  const answered = made !== null && allAnswer(probe.results, count);

  // Said once per file written, when every tool answered at its address.
  const told = useRef<GeneratedOut | null>(null);
  const onAnsweredRef = useRef(onAnswered);
  onAnsweredRef.current = onAnswered;
  useEffect(() => {
    if (!made || !answered || told.current === made.out) return;
    told.current = made.out;
    const byType = new Map(probe.results.map((r) => [r.type, r]));
    const tools = ORDER.flatMap((t) => { const r = byType.get(t); return r ? [{ type: t, url: r.url, version: r.version }] : []; });
    void onAnsweredRef.current(tools);
  }, [made, answered, probe.results]);

  // The button that was pressed leaves with the wait ending: the keyboard stays inside the block.
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (wasWaiting.current && !probe.waiting) {
      const active = document.activeElement;
      if (active === null || active === document.body) (again.current ?? status.current)?.focus();
    }
    wasWaiting.current = probe.waiting;
  }, [probe.waiting]);

  // Changing what the file is for takes the old file away: it would no longer match.
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setMade(null);
    setSaid("");
  };

  async function write(e: FormEvent) {
    e.preventDefault();
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setErrors({});
    setSaid("");
    try {
      const out = await generateFiles({
        kind, address: address.trim(), retention_days: Number(days.trim() === "" ? "0" : days),
        ...(kind === "servers" ? { servers: servers.split("\n").map((l) => l.trim()).filter((l) => l !== "") } : {}),
      });
      setMade({ out, address: address.trim() });
    } catch (err) {
      setMade(null);
      const text = failure(err, "try again");
      const next = text === ADDRESS_WORDS ? { address: text }
        : text === RETENTION_WORDS ? { days: text }
        : text === SERVERS_WORDS ? { servers: text }
        : { form: text };
      setErrors(next);
      const target = "address" in next ? addressInput : "days" in next ? daysInput : "servers" in next ? serversInput : null;
      target?.current?.focus();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setSaid(COPIED);
    } catch {
      setSaid(NOT_COPIED);
    }
  };

  const described = (id: string, has: boolean) => (has ? `${id}-err` : undefined);

  return (
    <section className={s.panel} aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className={s.heading}>{words.heading}</h3>
      <p className={s.lead}>{words.lead}</p>
      <form className={s.form} onSubmit={(e) => void write(e)} noValidate>
        <div className={s.pair}>
          <Field id={`${ids}-address`} label={words.address} error={errors.address ?? null}>
            <input id={`${ids}-address`} ref={addressInput} className={s.input} type="text" autoComplete="off" spellCheck={false}
              placeholder={words.placeholder} value={address} aria-invalid={errors.address ? true : undefined}
              aria-describedby={described(`${ids}-address`, !!errors.address)} onChange={(e) => edit(setAddress)(e.target.value)} />
          </Field>
          <Field id={`${ids}-days`} label="Keep data for" error={errors.days ?? null}>
            <span className={s.days}>
              <input id={`${ids}-days`} ref={daysInput} className={s.input} type="number" inputMode="numeric" value={days}
                aria-invalid={errors.days ? true : undefined} aria-describedby={described(`${ids}-days`, !!errors.days)}
                onChange={(e) => edit(setDays)(e.target.value)} />
              <span aria-hidden="true">days</span>
            </span>
          </Field>
        </div>
        {kind === "servers" && (
          <Field id={`${ids}-servers`} label="Servers to watch" error={errors.servers ?? null}>
            <textarea id={`${ids}-servers`} ref={serversInput} className={`${s.input} ${s.mono}`} rows={3} spellCheck={false}
              placeholder={"web-1.example\ndb-1.example:9100"} value={servers} aria-invalid={errors.servers ? true : undefined}
              aria-describedby={described(`${ids}-servers`, !!errors.servers)} onChange={(e) => edit(setServers)(e.target.value)} />
          </Field>
        )}
        {errors.form && <p className={s.problem} role="alert">{errors.form}</p>}
        <div className={s.actions}>
          <button type="submit" className={s.primary} aria-disabled={busy || undefined}>{words.write}</button>
        </div>
      </form>

      {made && file && (
        <div className={s.result}>
          <div className={s.fileBar}>
            <span className={s.fileName}>{file.name}</span>
            <span className={s.fileActions}>
              <button type="button" className={s.secondary} onClick={() => void copy()}>Copy</button>
              <button type="button" className={s.secondary} onClick={() => download(file)}>Download {file.name}</button>
            </span>
          </div>
          <pre className={s.file} aria-label={file.name} tabIndex={0}>{file.content}</pre>
          <span className={s.said} aria-live="polite">{said}</span>
          <Instructions kind={kind} file={file} address={made.address} portList={made.out.ports} />
          <Waiting urls={made.out.urls} results={probe.results} waiting={probe.waiting} gaveUp={probe.gaveUp} answered={answered}
            onStop={probe.stop} onAgain={probe.again} again={again} status={status} />
        </div>
      )}
    </section>
  );
}
