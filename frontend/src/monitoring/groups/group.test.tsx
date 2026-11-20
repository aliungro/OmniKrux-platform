import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);
const group = (id: string, name: string, project_ids: string[]): GroupOut => ({ id, name, project_ids, created_at: T, updated_at: T });
const projects = () => [seedProject("p1", "Dev"), seedProject("p2", "Stage"), seedProject("p3", "Prod east")];

describe("Groups", () => {
  it("a group is made from picked projects and shows shortcuts", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects() }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    expect(await screen.findByRole("heading", { name: "New group" })).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Everything dev");
    await user.click(await screen.findByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(api.state.groups).toHaveLength(1));
    const post = api.requests.find((r) => r.method === "POST" && r.url === "/api/monitoring/groups")!;
    expect(post.body).toEqual({ name: "Everything dev", project_ids: ["p1", "p2"] });
    expect(await screen.findByRole("heading", { name: "Everything dev" })).toBeTruthy();
    const shortcuts = screen.getByRole("list", { name: "Projects in this group" });
    expect(within(shortcuts).getAllByRole("button").map((b) => b.textContent)).toEqual(["↗Dev", "↗Stage"]);
    expect(screen.getByText("Group dashboards arrive in the next update.")).toBeTruthy();
    // The shortcut opens the project as it is.
    await user.click(within(shortcuts).getByRole("button", { name: /Dev/ }));
    expect(await screen.findByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(api.state.projects).toHaveLength(3);
  });

  it("shows the server's words when a group can't be made", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", [])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    await user.type(await screen.findByLabelText("Name"), "prod");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect((await screen.findByRole("alert")).textContent).toContain('A group named "prod" already exists.');
    expect(document.activeElement).not.toBe(document.body);
  });

  it("edits a group's projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    expect((screen.getByRole("checkbox", { name: "Dev" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("checkbox", { name: "Prod east" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.state.groups[0].project_ids).toEqual(["p3"]));
    expect(api.requests.find((r) => r.method === "PATCH")!.body).toEqual({ project_ids: ["p3"] });
    expect(await screen.findByRole("button", { name: "Edit projects" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit projects" }));
  });

  it("keeps the keyboard on Cancel when there are no projects to tick", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: [], groups: [group("g1", "Prod", [])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
  });

  it("renames a group", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Live{Enter}");
    await waitFor(() => expect(api.state.groups[0].name).toBe("Live"));
    expect(await screen.findByRole("heading", { name: "Live" })).toBeTruthy();
  });

  it("deleting a group keeps its projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Delete group Prod?" })).toBeTruthy();
    expect(within(dialog).getByText("Its projects stay as they are.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete group" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
    expect(api.state.groups).toHaveLength(0);
    expect(api.state.projects).toHaveLength(3);
    // Still in the sidebar.
    const sidebar = document.querySelector("nav, aside") as HTMLElement;
    expect(within(sidebar).getByText("Dev")).toBeTruthy();
    expect(within(sidebar).getByText("Stage")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Group focus and arrival", () => {
  const onMain = () => document.activeElement?.tagName === "MAIN";

  it("after Create group the keyboard is on the workspace and the group is never called gone", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects() }, fallback);
    // The tree answers slowly, as a real server can: the new group must not look gone meanwhile.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/monitoring/tree") await new Promise((r) => setTimeout(r, 30));
      return real(url, init);
    });
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    let saidGone = false;
    const watch = new MutationObserver(() => { if (document.body.textContent?.includes("no longer exists")) saidGone = true; });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    await user.type(await screen.findByLabelText("Name"), "Everything dev");
    await user.click(await screen.findByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("heading", { name: "Everything dev" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    watch.disconnect();
    expect(saidGone).toBe(false);
    expect(onMain()).toBe(true);
  });

  it("the shortcut hands the keyboard to the workspace, in this tab or a new one", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const shortcuts = await screen.findByRole("list", { name: "Projects in this group" });
    await user.click(within(shortcuts).getByRole("button", { name: /Dev/ }));
    expect(await screen.findByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(onMain()).toBe(true);

    cleanup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const stage = within(await screen.findByRole("list", { name: "Projects in this group" })).getByRole("button", { name: /Stage/ });
    stage.focus();
    fireEvent.click(stage, { ctrlKey: true });
    expect(await screen.findByRole("heading", { name: "Stage" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(onMain()).toBe(true);
  });
});

/** Records every Escape that gets past the page to the document, where the shell's keys live. */
function escapesToDocument() {
  const seen: string[] = [];
  const listen = (e: KeyboardEvent) => { if (e.key === "Escape") seen.push(e.key); };
  document.addEventListener("keydown", listen);
  return { seen, stop: () => document.removeEventListener("keydown", listen) };
}

describe("Esc closes Edit projects", () => {
  it("closes the panel, keeps the projects and returns the keyboard to Edit projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage" }));
    const doc = escapesToDocument();
    await user.keyboard("{Escape}");
    doc.stop();
    expect(screen.queryByRole("checkbox", { name: "Stage" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit projects" })));
    expect(doc.seen).toEqual([]);
    expect(api.state.groups[0].project_ids).toEqual(["p1"]);
  });
});
