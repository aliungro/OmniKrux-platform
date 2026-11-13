import { useQuery, type QueryClient } from "@tanstack/react-query";
import { deleteEmpty, getJson, postEmpty, postJson } from "./http";
import type { AccountIn, CliLogin, CloudAccount, Cluster, Discovered, SettingsInfo } from "./types";
import { CLUSTERS_QUERY_KEY, evictClusters } from "./useClusters";

const ACCOUNTS_QUERY_KEY = ["cloud-accounts"] as const;
const LOGINS_QUERY_KEY = ["cloud-logins"] as const;
export const CLOUD_DISCOVERED_QUERY_KEY = ["cloud-discovered"] as const;
const CLOUD_QUERY_KEYS = [ACCOUNTS_QUERY_KEY, LOGINS_QUERY_KEY, CLOUD_DISCOVERED_QUERY_KEY, CLUSTERS_QUERY_KEY];
const REFRESH_MS = 30_000;

export function useCloudAccounts() {
  return useQuery({ queryKey: ACCOUNTS_QUERY_KEY, queryFn: () => getJson<CloudAccount[]>("/api/cloud/accounts"), refetchInterval: REFRESH_MS });
}

export function useCliLogins() {
  return useQuery({ queryKey: LOGINS_QUERY_KEY, queryFn: () => getJson<CliLogin[]>("/api/cloud/logins") });
}

export function useDiscovered() {
  return useQuery({ queryKey: CLOUD_DISCOVERED_QUERY_KEY, queryFn: () => getJson<Discovered[]>("/api/cloud/discovered"), refetchInterval: REFRESH_MS });
}

export function useSettingsInfo() {
  return useQuery({ queryKey: ["settings"], queryFn: () => getJson<SettingsInfo>("/api/settings") });
}

function invalidateCloud(client: QueryClient) {
  for (const queryKey of CLOUD_QUERY_KEYS) void client.invalidateQueries({ queryKey });
}

export async function connectAccount(client: QueryClient, body: AccountIn): Promise<CloudAccount> {
  const account = await postJson<CloudAccount>("/api/cloud/accounts", body, { cache: "no-store" });
  invalidateCloud(client);
  return account;
}

export async function removeAccount(client: QueryClient, id: string): Promise<void> {
  await deleteEmpty(`/api/cloud/accounts/${encodeURIComponent(id)}`);
  await client.cancelQueries({ queryKey: ACCOUNTS_QUERY_KEY });
  client.setQueryData<CloudAccount[]>(ACCOUNTS_QUERY_KEY, accounts => accounts?.filter(account => account.id !== id));
  const owned = client.getQueryData<Cluster[]>(CLUSTERS_QUERY_KEY)?.filter(cluster => cluster.cloud?.account_id === id) ?? [];
  await evictClusters(client, owned.map(cluster => cluster.id));
  invalidateCloud(client);
}

export async function checkAccount(client: QueryClient, id: string): Promise<CloudAccount> {
  const account = await postJson<CloudAccount>(`/api/cloud/accounts/${encodeURIComponent(id)}/check`);
  invalidateCloud(client);
  return account;
}

export async function addDiscovered(client: QueryClient, ids: string[]) {
  const result = await postJson<{ added: Cluster[]; failed: { id: string; message: string }[] }>("/api/cloud/discovered/add", { ids });
  invalidateCloud(client);
  return result;
}

export async function dismissDiscovered(client: QueryClient, ids: string[]): Promise<void> {
  await postEmpty("/api/cloud/discovered/dismiss", { ids });
  invalidateCloud(client);
}
