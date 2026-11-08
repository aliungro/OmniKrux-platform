// Kinds as GET /api/kinds describes them (backend/omnikrux/resources/kinds.py), for tests.
import type { ColumnSpec, KindInfo, KindsResponse } from "../api/types";

const col = (key: string, label: string, type: ColumnSpec["type"] = "text", width: ColumnSpec["width"] = "m"): ColumnSpec =>
  ({ key, label, type, width });
const NAME = col("name", "Name", "text", "l");
const NAMESPACE = col("namespace", "Namespace");
const AGE = col("age", "Age", "age", "s");
const STATUS = col("status", "Status", "status");
const READY = col("ready", "Ready", "text", "s");

function kind(key: string, kindName: string, columns: ColumnSpec[], over: Partial<KindInfo> = {}): KindInfo {
  const [plural, ...group] = key.split(".");
  return {
    key, group: group.join("."), version: "v1", kind: kindName, plural, label: kindName, plural_label: plural,
    namespaced: true, short_names: [], columns, sort: "status", builtin: true, verbs: ["get", "list", "watch"],
    clusters: ["c1"], ...over,
  };
}

export const PODS = kind("pods", "Pod", [
  NAME, NAMESPACE, STATUS, READY, col("restarts", "Restarts", "number", "s"), col("cpu", "CPU", "cpu", "s"),
  col("memory", "Memory", "memory", "s"), col("node", "Node"), AGE,
]);
export const DEPLOYMENTS = kind("deployments.apps", "Deployment", [
  NAME, NAMESPACE, STATUS, READY, col("up_to_date", "Up-to-date", "number", "s"), col("available", "Available", "number", "s"),
  col("images", "Images", "text", "l"), AGE,
]);
export const STATEFULSETS = kind("statefulsets.apps", "StatefulSet", [NAME, NAMESPACE, STATUS, READY, AGE]);
export const SERVICES = kind("services", "Service", [NAME, NAMESPACE, col("type", "Type", "text", "s"), col("ports", "Ports"), AGE]);
export const NODES = kind("nodes", "Node", [
  NAME, STATUS, col("roles", "Roles"), col("version", "Version", "text", "s"), col("cpu", "CPU", "cpu", "s"),
  col("memory", "Memory", "memory", "s"), col("pods", "Pods", "pods", "s"), col("pressure", "Pressure"),
  col("taints", "Taints", "number", "s"), AGE,
], { namespaced: false });
export const EVENTS = kind("events", "Event", [
  NAMESPACE, col("status", "Type", "status", "s"), col("reason", "Reason"), col("object", "Object", "object", "l"),
  col("message", "Message", "text", "l"), col("count", "Count", "number", "s"), col("last_seen", "Last seen", "time", "s"),
], { sort: "recent" });
export const HELM = kind("helm-releases", "HelmRelease", [NAME, NAMESPACE, col("revision", "Revision", "number", "s"), STATUS,
  col("updated", "Updated", "time", "s")], { label: "Helm release", plural_label: "Helm releases", sort: "recent" });
export const CERTIFICATES = kind("certificates.cert-manager.io", "Certificate", [NAME, NAMESPACE, col("pc_ready", "Ready", "status", "s"), AGE],
  { builtin: false });

export const KINDS: KindsResponse = {
  kinds: [PODS, DEPLOYMENTS, STATEFULSETS, SERVICES, NODES, EVENTS, HELM, CERTIFICATES],
  clusters: { c1: { state: "ok", message: null, failed_groups: {} } },
};
