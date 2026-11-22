// Catalog fixtures for tests.
import type { ProjectOut } from "../api/types";
import type { CatalogMetricOut, CatalogOut, SourceCatalogOut, StreamLabelOut } from "./api";

export const metric = (name: string, over: Partial<CatalogMetricOut> = {}): CatalogMetricOut => ({
  name, type: null, help: null, unit: null, labels: [], series: 1, family: null, ...over,
});

export const stream = (name: string, values: string[]): StreamLabelOut => ({ name, values, truncated: false });

export const source = (id: string, over: Partial<SourceCatalogOut> = {}): SourceCatalogOut => ({
  source_id: id, source_name: id, source_type: "prometheus", state: "ok", message: null,
  built_at: "2026-11-19T10:00:00Z", metrics: [], labels: [], streams: [], notes: [], ...over,
});

export const catalogOf = (projectId: string, ...sources: SourceCatalogOut[]): CatalogOut => ({ project_id: projectId, sources });

export const projectOf = (id: string, name = id): ProjectOut => ({
  id, name, kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null,
  links: [], group_ids: [], created_at: "2026-11-19T10:00:00Z", updated_at: "2026-11-19T10:00:00Z",
});
