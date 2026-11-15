import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccountIn, CliLogin, CloudAccount, Cluster, SettingsInfo } from "../../api/types";
import { CLUSTERS_QUERY_KEY } from "../../api/useClusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "./SettingsView";
import { KINDS } from "../../test/kinds";
import { PINNED_KEY, resetPinnedKinds, savePinned } from "./pinnedKinds";
import type { ReactElement, ReactNode } from "react";

function render(view: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderView(view, { wrapper });
}

const rows = () => within(screen.getByRole("list",{name:"Pinned kinds"})).getAllByRole("listitem");
const rowOrder = () => rows().map(row => row.querySelector("strong")!.textContent);
function pointAt(target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientY = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return fireEvent(target, event);
}
function hitTest() {
  const before = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const hit = vi.fn();
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  return { hit, restore: () => {
    if (before) Object.defineProperty(document, "elementFromPoint", before);
    else Reflect.deleteProperty(document, "elementFromPoint");
  } };
}

it("settings adds, removes and reorders pinned kinds", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Pods"}));
  expect(rows()[0].textContent).toContain("Deployments");
  fireEvent.click(screen.getByRole("button",{name:"Move Services up"}));
  expect(rows()[3].textContent).toContain("Services");
  expect(screen.getByRole("status").textContent).toBe("Services moved to position 4 of 10.");
  fireEvent.click(screen.getByRole("button",{name:"Move Services down"}));
  expect(rows()[4].textContent).toContain("Services");
  expect(screen.getByRole("status").textContent).toBe("Services moved to position 5 of 10.");
  const add = screen.getByRole("combobox",{name:"Add a kind"});
  fireEvent.change(add,{target:{value:"cert"}});
  fireEvent.keyDown(add,{key:"ArrowDown"}); fireEvent.keyDown(add,{key:"Enter"});
  expect(rows().at(-1)!.textContent).toContain("Certificates");
  expect(screen.queryByRole("option",{name:"Certificates"})).toBeNull();
});
it("drops a dragged pin on either half of another row, persists it, and announces its position", () => {
  savePinned(localStorage, ["pods", "deployments.apps", "services", "secrets"]);
  const save = vi.spyOn(Storage.prototype, "setItem");
  const view = render(<SettingsView kinds={KINDS.kinds} />);
  const handle = screen.getByTitle("Drag Secrets to reorder");
  const pods = rows()[0], services = rows()[2];
  for (const target of [pods, services]) {
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40 } as DOMRect);
  }

  const { hit, restore } = hitTest();
  hit.mockReturnValue(pods);
  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove", 110);
  expect(pods.getAttribute("data-drop-placement")).toBe("before");
  expect(save).not.toHaveBeenCalled();
  pointAt(handle, "pointerup", 110);
  expect(rowOrder()).toEqual(["Secrets", "Pods", "Deployments", "Services"]);
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("Secrets moved to position 1 of 4.");

  hit.mockReturnValue(services);
  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove", 135);
  expect(services.getAttribute("data-drop-placement")).toBe("after");
  pointAt(handle, "pointerup", 135);
  restore();
  expect(rowOrder()).toEqual(["Pods", "Deployments", "Services", "Secrets"]);
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toBe("Secrets moved to position 4 of 4.");
  expect(JSON.parse(localStorage.getItem(PINNED_KEY)!).kinds).toEqual(["pods", "deployments.apps", "services", "secrets"]);

  view.unmount();
  resetPinnedKinds();
  render(<SettingsView kinds={KINDS.kinds} />);
  expect(rowOrder()).toEqual(["Pods", "Deployments", "Services", "Secrets"]);
});

it("clears cancelled drags and ignores drags that did not start on a handle", () => {
  const save = vi.spyOn(Storage.prototype, "setItem");
  render(<SettingsView kinds={KINDS.kinds} />);
  const initial = rowOrder();
  const pods = rows()[0], secrets = rows()[7];
  const handle = screen.getByTitle("Drag Secrets to reorder");
  const { hit, restore } = hitTest();
  hit.mockReturnValue(pods);
  pointAt(secrets, "pointerdown");
  pointAt(handle, "pointermove");
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  pointAt(handle, "pointerup");

  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove");
  expect(pods.getAttribute("data-drop-placement")).not.toBeNull();
  pointAt(handle, "pointercancel");
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  pointAt(handle, "pointerup");
  restore();
  expect(rowOrder()).toEqual(initial);
  expect(save).not.toHaveBeenCalled();
});
it("reset to default restores the row", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Secrets"}));
  fireEvent.click(screen.getByRole("button",{name:"Reset to default"}));
  expect(rows().map(r=>r.querySelector("strong")!.textContent)).toEqual(["Pods","Deployments","StatefulSets","DaemonSets","Jobs","Services","Ingresses","Secrets","Nodes","Events","Helm releases"]);
});
it("a pinned kind no cluster serves is marked in settings", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  const secrets = rows().find(r=>r.textContent?.includes("Secrets"))!;
  expect(secrets.textContent).toContain("No cluster serves this kind right now, so its tab is hidden.");
});
it("an unavailable catalog kind keeps its discovered title in settings", () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:["records.example.io"]}));
  render(<SettingsView kinds={[{...KINDS.kinds[0],key:"records.example.io",plural_label:"DNS records",clusters:[]}]}/>);
  expect(rows()[0].querySelector("strong")!.textContent).toBe("DNS records");
  expect(rows()[0].textContent).toContain("No cluster serves this kind right now, so its tab is hidden.");
});
it("empty pins explain the row and unmatched add searches explain the result", () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:[]}));
  render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByText("No pinned kinds: only the kind you open gets a tab.")).toBeTruthy();
  const add=screen.getByRole("combobox"); fireEvent.change(add,{target:{value:"nothing matches"}});
  expect(screen.getByText("No kind matches")).toBeTruthy();
});
it("a save problem is said in this browser and clears after a successful save", () => {
  const set=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new DOMException("full","QuotaExceededError");});
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Pods"}));
  expect(within(screen.getByRole("region",{name:"This browser"})).getByRole("alert").textContent).toBe("Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.");
  set.mockRestore(); fireEvent.click(screen.getByRole("button",{name:"Reset to default"}));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("workspace save problems are also said in this browser", () => {
  render(<SettingsView kinds={KINDS.kinds} saveProblem="this browser blocks site storage"/>);
  expect(screen.getByRole("alert").textContent).toContain("this browser blocks site storage");
});
it("workspace and pinned save failures remain independently visible in Settings", () => {
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  const view = render(<SettingsView kinds={KINDS.kinds} saveProblem="this browser blocks site storage"/>);
  fireEvent.click(screen.getByRole("button", { name: "Remove Pods" }));
  expect(screen.getAllByRole("alert").map(el => el.textContent)).toEqual([
    "Tabs can't be saved in this browser (this browser blocks site storage). They last until you close this page.",
    "Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.",
  ]);
  view.rerender(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByRole("alert").textContent).toContain("Pinned kinds can't be saved");
  set.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("edit pinned kinds reaches the section without writing its anchor into the route", () => {
  const scroll=vi.fn(); Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:scroll});
  history.replaceState(null,"","/#/settings");
  render(<SettingsView kinds={KINDS.kinds} section="pinned-kinds"/>);
  expect(scroll).toHaveBeenCalled();
  expect(screen.getByRole("region",{name:"Pinned kinds"}).id).toBe("pinned-kinds");
  expect(location.hash).toBe("#/settings");
  delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView;
});

it.each([
  ["broken", "they aren't valid JSON"],
  ['{"version":2,"kinds":["pods"]}', "they're from another version of Omnikrux"],
  ['{"version":1,"kinds":["bad/key"]}', "the saved list contains an invalid kind"],
])("unreadable pinned storage explains its own reset once: %s", (raw, reason) => {
  localStorage.setItem("omnikrux.pinnedKinds",raw);
  const view=render(<SettingsView kinds={KINDS.kinds}/>);
  expect(rows()[0].querySelector("strong")!.textContent).toBe("Pods");
  expect(screen.getByRole("alert").textContent).toContain(`Your saved pinned kinds couldn't be read (${reason}), so Omnikrux restored the default pinned kinds.`);
  fireEvent.click(screen.getByRole("button",{name:"Remove Services"}));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button",{name:"Dismiss pinned kinds notice"}));
  view.unmount(); render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("a blocked pinned storage read explains the fallback separately from tabs", () => {
  vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw new DOMException("blocked","SecurityError");});
  render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByRole("alert").textContent).toContain("Your saved pinned kinds couldn't be read (this browser blocks site storage)");
  expect(screen.getByRole("alert").textContent).not.toContain("fresh Home tab");
});
it("keyboard removal follows the next row, previous row, then add field", async () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:["pods","services","nodes"]}));
  const user=userEvent.setup(); render(<SettingsView kinds={KINDS.kinds}/>);
  screen.getByRole("button",{name:"Remove Services"}).focus(); await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Remove Nodes"}));
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Remove Pods"}));
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("combobox",{name:"Add a kind"}));
});
it("the picker scrolls the keyboard active option into view", () => {
  const scrolled: Element[]=[];
  Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:function(this:Element) {scrolled.push(this);}});
  try {
    const kinds=Array.from({length:30},(_,i)=>({...KINDS.kinds[0],key:`item-${i}`,plural_label:`Kind ${String(i).padStart(2,"0")}`}));
    render(<SettingsView kinds={kinds}/>);
    const add=screen.getByRole("combobox"); fireEvent.focus(add);
    for(let i=0;i<20;i++) fireEvent.keyDown(add,{key:"ArrowDown"});
    expect(scrolled.at(-1)).toBe(document.getElementById(add.getAttribute("aria-activedescendant")!));
  } finally { delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView; }
});

const awsPath = "/fixture/aws";
const windowsNote = "Your Azure CLI login is encrypted for your Windows account, so the console's container can't read it. Connect with a service principal instead (Settings → Cloud accounts → Enter credentials).";
const logins: CliLogin[] = [
  { provider: "aws", path: awsPath, state: "found", note: null, choices: [
    { value: "default", label: "default" }, { value: "engineering", label: "engineering" },
  ] },
  { provider: "gcp", path: "/fixture/gcloud", state: "missing", note: null, choices: [] },
  { provider: "azure", path: "/fixture/azure", state: "unreadable", note: windowsNote, choices: [] },
];
const account: CloudAccount = {
  id: "aws-engineering", provider: "aws", kube_provider: "eks", name: "Engineering", source: "cli",
  scope: "123456789012", principal: "Fixture principal", regions: ["us-east-1", "us-west-2"], profile: "engineering",
  has_secret: false, check: { state: "never", checked_at: null, message: null, problems: [] },
  counts: { found: 4, added: 2, new: 2 },
};
const fileCluster: Cluster = {
  id: "c1", name: "Local East", context_name: "local-east", server: "https://east.invalid", original_server: null,
  provider: "kind", region: null, environment: "development", state: "ready", message: null,
  source: "file", kubernetes_version: "v1.32.0", node_pools: [], node_count: null, cloud: null, cloud_note: null,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const readBody = (init: RequestInit) => JSON.parse(String(init.body)) as unknown;
const fixtureSecret = (label: string) => `fixtureSecret${label}`.padEnd(40, "x");
const envSettings: SettingsInfo = { encryption: { source: "environment", path: null }, discovery_interval_s: 600 };
const fileSettings: SettingsInfo = { encryption: { source: "file", path: "/data/fixture.key" }, discovery_interval_s: 600 };

function serve({ accounts = [], clusters = [], settings = envSettings, write }: {
  accounts?: CloudAccount[];
  clusters?: Cluster[] | (() => Response | Promise<Response>);
  settings?: SettingsInfo;
  write?: (path: string, init: RequestInit) => Response | Promise<Response>;
} = {}) {
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method && init.method !== "GET" && write) return write(path, init);
    if (!init.method || init.method === "GET") {
      if (path === "/api/cloud/logins") return json(logins);
      if (path === "/api/cloud/accounts") return json(accounts);
      if (path === "/api/cloud/discovered") return json([]);
      if (path === "/api/clusters") return typeof clusters === "function" ? clusters() : json(clusters);
      if (path === "/api/settings") return json(settings);
    }
    throw new Error(`Unexpected request to ${path}`);
  }));
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<SettingsView kinds={KINDS.kinds} />, client);
  return client;
}

async function openConnect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /^Connect/ }));
  return within(await screen.findByRole("dialog"));
}

async function enterAwsCredentials(user: ReturnType<typeof userEvent.setup>, form: ReturnType<typeof within>) {
  await user.selectOptions(form.getByRole("combobox", { name: /provider/i }), form.getByRole("option", { name: "AWS account" }));
  await user.click(form.getByRole("radio", { name: "Enter credentials" }));
  fireEvent.change(form.getByLabelText(/Access key ID/i), { target: { value: "AKIA0123456789ABCDEF" } });
  fireEvent.change(form.getByRole("textbox", { name: /Regions/i }), { target: { value: "us-east-1, us-west-2" } });
  return form.getByLabelText(/^Secret access key/i) as HTMLInputElement;
}

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("logins show found, missing and notes, and Windows Azure offers entered credentials", async () => {
  serve();
  show();
  expect(await screen.findByText(`AWS CLI login found at ${awsPath}`)).toBeTruthy();
  expect(screen.getByText(/No gcloud login at \/fixture\/gcloud/i)).toBeTruthy();
  expect(screen.getByText(windowsNote)).toBeTruthy();

  const user = userEvent.setup();
  const form = await openConnect(user);
  const provider = form.getByRole("combobox", { name: /provider/i });
  await user.selectOptions(provider, form.getByRole("option", { name: "Azure subscription" }));
  expect(form.getByRole<HTMLInputElement>("radio", { name: /^Use my Azure CLI login/ }).disabled).toBe(true);
  expect(form.getByText(windowsNote)).toBeTruthy();
  await user.click(form.getByRole("radio", { name: "Enter credentials" }));
  expect(form.getByLabelText<HTMLInputElement>(/^Client secret/i).type).toBe("password");

  await user.selectOptions(provider, form.getByRole("option", { name: "Google Cloud project" }));
  expect(form.getByRole<HTMLInputElement>("radio", { name: /Use my gcloud login/i }).disabled).toBe(true);
  expect(form.getByText(/No gcloud login at \/fixture\/gcloud/i)).toBeTruthy();
});

it("connect with CLI login sends only the selected provider and source fields", async () => {
  const post = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe("/api/cloud/accounts");
    expect(init.method).toBe("POST");
    return json(account, 201);
  });
  serve({ write: post });
  show();
  await screen.findByText(`AWS CLI login found at ${awsPath}`);
  const user = userEvent.setup();
  const form = await openConnect(user);
  const secret = await enterAwsCredentials(user, form);
  fireEvent.change(secret, { target: { value: fixtureSecret("Unused") } });
  await user.click(form.getByRole("radio", { name: "Use my AWS CLI login" }));
  await user.selectOptions(form.getByRole("combobox", { name: /Profile/i }), "engineering");
  const regions = form.getByRole("textbox", { name: /Regions/i });
  await user.clear(regions);
  await user.type(regions, "us-east-1, us-west-2");
  await user.click(form.getByRole("button", { name: "Connect" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(post).toHaveBeenCalledTimes(1);
  expect(readBody(post.mock.calls[0][1])).toEqual({
    provider: "aws", source: "cli", profile: "engineering", regions: ["us-east-1", "us-west-2"],
  });
});

function cacheSnapshot(client: QueryClient) {
  return JSON.stringify({
    queries: client.getQueryCache().getAll().map(({ queryKey, state, meta }) => ({ queryKey, state, meta })),
    mutations: client.getMutationCache().getAll().map(({ options, state }) => ({ options, state })),
  }, (_key, value: unknown) => value instanceof Error ? { name: value.name, message: value.message } : value);
}

function browserStorage() {
  return [localStorage, sessionStorage].flatMap(storage => Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return [key, storage.getItem(key)];
  }));
}

it("entered secrets clear while checking, after refusal and success, and on close without reaching caches or storage", async () => {
  const rejected = fixtureSecret("Rejected");
  const accepted = fixtureSecret("Accepted");
  const abandoned = fixtureSecret("Abandoned");
  const replies: Array<(response: Response) => void> = [];
  const post = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe("/api/cloud/accounts");
    expect(init.method).toBe("POST");
    return new Promise<Response>(resolve => replies.push(resolve));
  });
  serve({ write: post });
  const client = show();
  const writeStorage = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  const form = await openConnect(user);
  const secretField = await enterAwsCredentials(user, form);
  const submit = () => user.click(form.getByRole("button", { name: "Connect" }));
  const expectAbsent = (secret: string) => {
    expect(screen.queryAllByDisplayValue(secret)).toHaveLength(0);
    expect(document.body.textContent).not.toContain(secret);
    expect(cacheSnapshot(client)).not.toContain(secret);
    expect(JSON.stringify(browserStorage())).not.toContain(secret);
    expect(JSON.stringify(writeStorage.mock.calls)).not.toContain(secret);
  };
  expect(secretField.type).toBe("password");
  expect(secretField.autocomplete).toBe("off");
  expect(form.getByText("Stored encrypted with the console's key and never sent back to the browser.")).toBeTruthy();

  fireEvent.change(secretField, { target: { value: rejected } });
  expect(cacheSnapshot(client)).not.toContain(rejected);
  await submit();
  expect(await form.findByText("Checking the login…")).toBeTruthy();
  expectAbsent(rejected);
  const refusal = "The selected account credentials were refused.";
  await act(async () => replies[0](json({ detail: refusal }, 422)));
  expect(await form.findByText(refusal)).toBeTruthy();
  const retryField = form.getByLabelText<HTMLInputElement>(/^Secret access key/i);
  expect(retryField.value).toBe("");
  expectAbsent(rejected);

  fireEvent.change(retryField, { target: { value: accepted } });
  await submit();
  expect(await form.findByText("Checking the login…")).toBeTruthy();
  expectAbsent(accepted);
  await act(async () => replies[1](json({ ...account, source: "entered", profile: null, has_secret: true }, 201)));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expectAbsent(rejected);
  expectAbsent(accepted);
  expect(post.mock.calls.map(([, init]) => readBody(init))).toEqual([rejected, accepted].map(secret => ({
    provider: "aws", source: "entered", access_key_id: "AKIA0123456789ABCDEF", secret_access_key: secret,
    regions: ["us-east-1", "us-west-2"],
  })));

  const cancelForm = await openConnect(user);
  fireEvent.change(await enterAwsCredentials(user, cancelForm), { target: { value: abandoned } });
  await user.click(cancelForm.queryByRole("button", { name: "Cancel" }) ?? cancelForm.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expectAbsent(abandoned);
  const reopened = await openConnect(user);
  expect((await enterAwsCredentials(user, reopened)).value).toBe("");
  expect(post).toHaveBeenCalledTimes(2);
});

it("a Google Cloud key file is read without ever being shown, and is gone after a refusal", async () => {
  const key = JSON.stringify({ type: "service_account", private_key: fixtureSecret("GcpKey") });
  const replies: Array<(response: Response) => void> = [];
  const post = vi.fn((_path: string, _init: RequestInit) => new Promise<Response>(resolve => replies.push(resolve)));
  serve({ write: post });
  const client = show();
  const user = userEvent.setup();
  const form = await openConnect(user);
  await user.selectOptions(form.getByRole("combobox", { name: /provider/i }), form.getByRole("option", { name: "Google Cloud project" }));
  fireEvent.change(form.getByLabelText(/Project ID/i), { target: { value: "fixture-project" } });
  const picker = form.getByLabelText<HTMLInputElement>("Choose key file");
  expect(picker.type).toBe("file");
  await user.upload(picker, new File([key], "fixture-key.json", { type: "application/json" }));
  expect(await form.findByText(`Key loaded from fixture-key.json (${key.length} bytes)`)).toBeTruthy();
  expect(picker.value).toBe("");
  expect(document.body.textContent).not.toContain(fixtureSecret("GcpKey"));
  expect(screen.queryAllByDisplayValue(key)).toHaveLength(0);
  await user.click(form.getByRole("button", { name: "Connect" }));
  await act(async () => replies[0](json({ detail: "The key was refused." }, 422)));
  expect(await form.findByText("The key was refused.")).toBeTruthy();
  expect(form.queryByText(/Key loaded from/)).toBeNull();
  expect(readBody(post.mock.calls[0][1])).toEqual({
    provider: "gcp", source: "entered", project_id: "fixture-project", service_account_key: key,
  });
  expect(cacheSnapshot(client)).not.toContain(fixtureSecret("GcpKey"));
  expect(JSON.stringify(browserStorage())).not.toContain(fixtureSecret("GcpKey"));
});

it("a pasted Oracle Cloud key is masked until shown and cleared when the dialog closes", async () => {
  const pem = `-----BEGIN PRIVATE KEY-----
${fixtureSecret("OciKey")}
-----END PRIVATE KEY-----`;
  show();
  const user = userEvent.setup();
  const form = await openConnect(user);
  await user.selectOptions(form.getByRole("combobox", { name: /provider/i }), form.getByRole("option", { name: "Oracle Cloud tenancy" }));
  const pasted = form.getByLabelText<HTMLTextAreaElement>("Or paste the key");
  expect(pasted.dataset.masked).toBe("true");
  fireEvent.change(pasted, { target: { value: pem } });
  const reveal = form.getByRole("button", { name: "Show key" });
  expect(reveal.getAttribute("aria-pressed")).toBe("false");
  await user.click(reveal);
  expect(pasted.dataset.masked).toBe("false");
  await user.click(form.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const reopened = await openConnect(user);
  await user.selectOptions(reopened.getByRole("combobox", { name: /provider/i }), reopened.getByRole("option", { name: "Oracle Cloud tenancy" }));
  const again = reopened.getByLabelText<HTMLTextAreaElement>("Or paste the key");
  expect(again.value).toBe("");
  expect(again.dataset.masked).toBe("true");
});

it("connect conflict stays in the dialog in the server's words", async () => {
  const detail = "This AWS account is already connected.";
  serve({ write: () => json({ detail }, 409) });
  show();
  await screen.findByText(`AWS CLI login found at ${awsPath}`);
  const user = userEvent.setup();
  const form = await openConnect(user);
  const secret = await enterAwsCredentials(user, form);
  fireEvent.change(secret, { target: { value: fixtureSecret("Duplicate") } });
  await user.click(form.getByRole("button", { name: "Connect" }));
  expect(await form.findByText(detail)).toBeTruthy();
  expect(form.getByRole("button", { name: "Connect" })).toBeTruthy();
});

const multilineCases: {
  option: string; fields: Record<string, string>; secretLabel: string; secret: string; body: AccountIn;
}[] = [
  {
    option: "Google Cloud project", fields: { "Project ID": "engineering-dev" },
    secretLabel: "Service account key JSON", secret: '{\n  "private_key": "fixture"\n}',
    body: { provider: "gcp", source: "entered", project_id: "engineering-dev", service_account_key: '{\n  "private_key": "fixture"\n}' },
  },
  {
    option: "Oracle Cloud tenancy", fields: {
      "Tenancy OCID": "ocid1.tenancy.oc1..fixture", "User OCID": "ocid1.user.oc1..fixture",
      Fingerprint: "aa:bb:cc", Regions: "us-ashburn-1", "Passphrase (optional)": "fixture passphrase",
    },
    secretLabel: "Private key (PEM)", secret: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
    body: {
      provider: "oci", source: "entered", tenancy_ocid: "ocid1.tenancy.oc1..fixture", user_ocid: "ocid1.user.oc1..fixture",
      fingerprint: "aa:bb:cc", regions: ["us-ashburn-1"], passphrase: "fixture passphrase",
      private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
    },
  },
];

it.each(multilineCases)("connect preserves line breaks for $option", async ({ option, fields, secretLabel, secret, body }) => {
  const post = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe("/api/cloud/accounts");
    expect(init.method).toBe("POST");
    return json({ detail: "Credentials refused." }, 422);
  });
  serve({ write: post });
  show();
  const user = userEvent.setup();
  const form = await openConnect(user);
  await user.selectOptions(form.getByRole("combobox", { name: "Provider" }), form.getByRole("option", { name: option }));
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(form.getByLabelText(label, { exact: false }), { target: { value } });
  }
  const key = within(form.getByRole("group", { name: secretLabel }));
  const input = key.getByRole<HTMLTextAreaElement>("textbox", { name: "Or paste the key" });
  expect(input.dataset.masked).toBe("true");
  expect(input.autocomplete).toBe("off");
  expect(input.getAttribute("spellcheck")).toBe("false");
  fireEvent.change(input, { target: { value: secret } });
  await user.click(form.getByRole("button", { name: "Connect" }));
  expect(await form.findByText("Credentials refused.")).toBeTruthy();
  expect(input.value).toBe("");
  expect(post).toHaveBeenCalledTimes(1);
  expect(readBody(post.mock.calls[0][1])).toEqual(body);
});

it("remove account confirms with its added cluster count", async () => {
  serve({ accounts: [account] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Remove(?: Engineering)?$/ }));
  const dialog = within(await screen.findByRole("alertdialog"));
  expect(dialog.getByText(/Remove the AWS account Engineering\?/i)).toBeTruthy();
  expect(dialog.getByText(/Its 2 clusters leave Omnikrux too\. Nothing changes in AWS\./)).toBeTruthy();
});

it("removing an account replaces a pending initial cluster read and moves focus to Cloud accounts", async () => {
  const cluster = { ...fileCluster, source: "cloud", server: null, provider: "eks", cloud: {
    account_id: account.id, account_name: account.name, resource_id: "fixture-resource",
  } } satisfies Cluster;
  const reads: Array<(response: Response) => void> = [];
  const clusters = vi.fn(() => new Promise<Response>(resolve => { reads.push(resolve); }));
  const accounts = [account];
  const remove = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe(`/api/cloud/accounts/${account.id}`);
    expect(init.method).toBe("DELETE");
    accounts.length = 0;
    return new Response(null, { status: 204 });
  });
  serve({ accounts, clusters, write: remove });
  const client = show();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: `Remove ${account.name}` });
  await user.click(trigger);
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
  expect(await screen.findByText("No cloud accounts yet. Connect one to find its clusters.")).toBeTruthy();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(clusters).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Cloud accounts" }));

  await act(async () => reads[0](json([cluster])));
  expect(client.getQueryData(CLUSTERS_QUERY_KEY)).toBeUndefined();
  await act(async () => reads[1](json([])));
  expect(await screen.findByText("No clusters in Omnikrux yet.")).toBeTruthy();
  expect(client.getQueryData(CLUSTERS_QUERY_KEY)).toEqual([]);
});

it("remove file cluster says it comes back and initially focuses Cancel", async () => {
  serve({ clusters: [fileCluster] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Remove(?: Local East)?$/ }));
  const dialog = within(await screen.findByRole("alertdialog"));
  expect(dialog.getByText(/Remove Local East from Omnikrux\?/)).toBeTruthy();
  expect(dialog.getByText("kubeconfig file · Context local-east")).toBeTruthy();
  expect(dialog.getByText(/comes back on the next start unless you remove its context/)).toBeTruthy();
  expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Cancel" }));
});

it("identifies the uploaded kubeconfig when cluster names and contexts match", async () => {
  const upload = { ...fileCluster, id: "c2", source: "upload", server: "https://upload.invalid" } satisfies Cluster;
  serve({ clusters: [fileCluster, upload] });
  show();
  const user = userEvent.setup();
  const list = within(await screen.findByRole("list", { name: "Clusters in Omnikrux" }));
  const uploaded = list.getByText(/uploaded kubeconfig/).closest("li")!;
  await user.click(within(uploaded).getByRole("button", { name: "Remove Local East" }));
  const confirmation = within(screen.getByRole("alertdialog", { name: "Remove Local East from Omnikrux?" }));
  expect(confirmation.getByText("uploaded kubeconfig · Context local-east")).toBeTruthy();
  expect(confirmation.queryByText(/comes back on the next start/)).toBeNull();
});

it("identifies the chosen account and region when cloud clusters share a name", async () => {
  const east = { ...fileCluster, source: "cloud", name: "Production", provider: "eks", region: "us-east-1", server: null,
    cloud: { account_id: "east", account_name: "East team", resource_id: "fixture-east" } } satisfies Cluster;
  const west = { ...east, id: "c2", region: "us-west-2",
    cloud: { account_id: "west", account_name: "West team", resource_id: "fixture-west" } } satisfies Cluster;
  serve({ clusters: [east, west] });
  show();
  const user = userEvent.setup();
  const list = within(await screen.findByRole("list", { name: "Clusters in Omnikrux" }));
  const westRow = list.getByText("West team · us-west-2").closest("li")!;
  await user.click(within(westRow).getByRole("button", { name: "Remove Production" }));
  const confirmation = within(screen.getByRole("alertdialog", { name: "Remove Production from Omnikrux?" }));
  expect(confirmation.getByText("West team · us-west-2")).toBeTruthy();
  expect(confirmation.queryByText("East team · us-east-1")).toBeNull();
});

it("evicts the removed cluster from the shared cache before the next registry response", async () => {
  let registryRefresh: ((response: Response) => void) | undefined;
  const clusters = vi.fn<() => Response | Promise<Response>>();
  clusters.mockImplementationOnce(() => json([fileCluster])).mockImplementation(() => new Promise(resolve => { registryRefresh = resolve; }));
  const remove = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe(`/api/clusters/${fileCluster.id}`);
    expect(init.method).toBe("DELETE");
    return new Response(null, { status: 204 });
  });
  serve({ clusters, write: remove });
  const client = show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: `Remove ${fileCluster.name}` }));
  const dialog = within(await screen.findByRole("alertdialog"));
  await user.click(dialog.getByRole("button", { name: "Remove" }));
  expect(await screen.findByText("No clusters in Omnikrux yet.")).toBeTruthy();
  expect(client.getQueryData(CLUSTERS_QUERY_KEY)).toEqual([]);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Clusters" }));
  expect(registryRefresh).toBeTypeOf("function");
  await act(async () => registryRefresh?.(json([])));
});

it("import kubeconfig shows the server's conflict message", async () => {
  const detail = "The kubeconfig already has a different cluster with that context.";
  const kubeconfig = "apiVersion: v1\nkind: Config\n";
  const post = vi.fn((path: string, init: RequestInit) => {
    expect(path).toBe("/api/clusters/kubeconfig");
    expect(init.method).toBe("POST");
    expect(readBody(init)).toEqual({ kubeconfig });
    return json({ detail }, 409);
  });
  serve({ write: post });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByText("Add from a kubeconfig"));
  const paste = await screen.findByRole("textbox", { name: /paste|kubeconfig/i });
  await user.click(paste);
  await user.paste(kubeconfig);
  await user.click(screen.getByRole("button", { name: /^(Add|Import)(?: clusters| kubeconfig)?$/i }));
  expect(await screen.findByText(detail)).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
  // The pasted text stays only while the import is open, so it can be corrected.
  expect((paste as HTMLTextAreaElement).value).toBe(kubeconfig);
  await user.click(screen.getByText("Add from a kubeconfig"));
  await user.click(screen.getByText("Add from a kubeconfig"));
  expect((screen.getByRole("textbox", { name: /paste|kubeconfig/i }) as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByText(detail)).toBeNull();
});

it.each([
  [envSettings, /Secrets are encrypted with the key from OMNIKRUX_SECRET_KEY/],
  [fileSettings, /Secrets are encrypted with the key in \/data\/fixture\.key, created on first start/],
] as const)("encryption section names the key source %#", async (settings, copy) => {
  serve({ settings });
  show();
  await waitFor(() => expect(document.body.textContent).toMatch(copy));
});
