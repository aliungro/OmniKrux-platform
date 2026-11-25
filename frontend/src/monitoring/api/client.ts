import { deleteEmpty, getJson, patchJson, postJson, putJson } from "../../api/http";
import type {
  AlertingOut, DiscoveryOut, FieldCatalogOut, FilterCheckOut, FilterOrigin, GroupDeleteReviewOut, GroupIn, GroupOut, GroupPatch, HealthOut, LinkOut,
  ProjectDeleteReviewOut, ProjectOut, SetupIn, SourceDeleteReviewOut, SourceIn, SourceOut, SourcePatch,
  SuggestIn, SuggestOut, TestOut, TreeOut,
} from "./types";

const BASE = "/api/monitoring";
const enc = encodeURIComponent;

// --- Sources ---------------------------------------------------------------------------------

export const listSources = () => getJson<SourceOut[]>(`${BASE}/sources`);
export const createSource = (body: SourceIn) => postJson<SourceOut>(`${BASE}/sources`, body);
export const updateSource = (id: string, body: SourcePatch) => patchJson<SourceOut>(`${BASE}/sources/${enc(id)}`, body);
export const sourceDeleteReview = (id: string) => getJson<SourceDeleteReviewOut>(`${BASE}/sources/${enc(id)}/delete-review`);
export const deleteSource = (id: string, token: string) => deleteEmpty(`${BASE}/sources/${enc(id)}?token=${enc(token)}`);
export const testNewSource = (body: SourceIn) => postJson<TestOut>(`${BASE}/sources/test`, body);
export const testSource = (id: string) => postJson<TestOut>(`${BASE}/sources/${enc(id)}/test`);
export const sourceHealth = (refresh = false) => getJson<Record<string, HealthOut>>(`${BASE}/sources/health${refresh ? "?refresh=true" : ""}`);
/** The metrics and labels a source holds for one project (that project's link filter applied). */
export const sourceFields = (id: string, projectId: string) =>
  getJson<FieldCatalogOut>(`${BASE}/sources/${enc(id)}/fields?project=${enc(projectId)}`);
/** Whether anything in the source matches a filter (nothing is stored). */
export const checkFilter = (id: string, filter: string, signal?: AbortSignal) =>
  postJson<FilterCheckOut>(`${BASE}/sources/${enc(id)}/filter-check`, { filter }, { signal });
export const sourceAlerting = (id: string) => getJson<AlertingOut>(`${BASE}/sources/${enc(id)}/alerting`);

// --- Discovery and suggestions ---------------------------------------------------------------

export const discover = (clusterId: string) => getJson<DiscoveryOut>(`${BASE}/discovery/${enc(clusterId)}`);
export const suggestFilter = (body: SuggestIn) => postJson<SuggestOut>(`${BASE}/suggest-filter`, body);

// --- Projects --------------------------------------------------------------------------------

export const getTree = () => getJson<TreeOut>(`${BASE}/tree`);
export const listProjects = () => getJson<ProjectOut[]>(`${BASE}/projects`);
export const getProject = (id: string) => getJson<ProjectOut>(`${BASE}/projects/${enc(id)}`);
export const renameProject = (id: string, name: string) => patchJson<ProjectOut>(`${BASE}/projects/${enc(id)}`, { name });
export const linkSource = (projectId: string, sourceId: string, filter: string, origin: FilterOrigin) =>
  putJson<LinkOut>(`${BASE}/projects/${enc(projectId)}/sources/${enc(sourceId)}`, { filter, origin });
export const unlinkSource = (projectId: string, sourceId: string) =>
  deleteEmpty(`${BASE}/projects/${enc(projectId)}/sources/${enc(sourceId)}`);
export const projectDeleteReview = (id: string) => getJson<ProjectDeleteReviewOut>(`${BASE}/projects/${enc(id)}/delete-review`);
export const deleteProject = (id: string, token: string) => deleteEmpty(`${BASE}/projects/${enc(id)}?token=${enc(token)}`);
export const setupProject = (body: SetupIn) => postJson<ProjectOut>(`${BASE}/setup`, body);

// --- Groups ----------------------------------------------------------------------------------

export const listGroups = () => getJson<GroupOut[]>(`${BASE}/groups`);
export const createGroup = (body: GroupIn) => postJson<GroupOut>(`${BASE}/groups`, body);
export const updateGroup = (id: string, body: GroupPatch) => patchJson<GroupOut>(`${BASE}/groups/${enc(id)}`, body);
/** What deleting the group takes with it (its dashboards); its token allows the delete. */
export const groupDeleteReview = (id: string) => getJson<GroupDeleteReviewOut>(`${BASE}/groups/${enc(id)}/delete-review`);
/** A group with dashboards needs its review's `token` (409 without it); one without deletes as is. */
export const deleteGroup = (id: string, token?: string) =>
  deleteEmpty(`${BASE}/groups/${enc(id)}${token === undefined ? "" : `?token=${enc(token)}`}`);
