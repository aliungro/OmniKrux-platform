import { describe, expect, it } from "vitest";
import { formatLabels, legendName, seriesNames } from "./legend";

describe("legend", () => {
  it("legend templates", () => {
    expect(legendName("{{route}}", { route: "/a" }, "A")).toBe("/a");
    expect(legendName("", { __name__: "up", job: "x" }, "A")).toBe('{job="x"}');
    expect(legendName("", {}, "sum(up)")).toBe("sum(up)");
  });

  it("fills every placeholder, spaces allowed, and leaves a missing label empty", () => {
    expect(legendName("{{ method }} {{route}} ({{code}})", { method: "GET", route: "/a" }, "A")).toBe("GET /a ()");
    expect(legendName("{{__name__}} on {{job}}", { __name__: "up", job: "x" }, "A")).toBe("up on x");
    expect(legendName("total", { job: "x" }, "A")).toBe("total");
    // A whitespace-only template is no template.
    expect(legendName("  ", { job: "x" }, "A")).toBe('{job="x"}');
  });

  it("formats label sets sorted and without the metric name", () => {
    expect(formatLabels({ c: "d", a: "b", __name__: "up" })).toBe('{a="b", c="d"}');
    expect(formatLabels({ __name__: "up" })).toBe("up");
    expect(formatLabels({})).toBe("{}");
    expect(formatLabels({ a: 'x"y\\z' })).toBe('{a="x\\"y\\\\z"}');
  });
});

describe("seriesNames", () => {
  it("series are named by the labels that differ", () => {
    const sets = [
      { __name__: "cpu", namespace: "demo", pod: "api-1", job: "kubelet" },
      { __name__: "cpu", namespace: "demo", pod: "api-2", job: "kubelet" },
      { __name__: "cpu", namespace: "shop", pod: "web-1", job: "kubelet" },
    ];
    expect(seriesNames(sets)).toEqual(["namespace=demo, pod=api-1", "namespace=demo, pod=api-2", "namespace=shop, pod=web-1"]);
    // __name__ counts only when it differs; a label one series lacks tells it apart.
    expect(seriesNames([{ __name__: "a", x: "1" }, { __name__: "b", x: "1" }])).toEqual(["__name__=a", "__name__=b"]);
    expect(seriesNames([{ x: "1" }, { x: "1", y: "2" }])).toEqual(["", "y=2"]);
  });

  it("cAdvisor series lead with namespace and pod, never with a cgroup path", () => {
    const cadvisor = (over: Record<string, string>) => ({
      __name__: "container_cpu_usage_seconds_total", instance: "omnikrux-dev-control-plane", job: "kubelet",
      kubernetes_io_hostname: "omnikrux-dev-control-plane", beta_kubernetes_io_arch: "amd64", ...over,
    });
    const sets = [
      cadvisor({ namespace: "demo", pod: "logger", container: "helper", id: "/kubelet.slice/kubelet-kubepods.slice/pod1/c1", image: "busybox:1", name: "c1" }),
      cadvisor({ namespace: "demo", pod: "logger", container: "main", id: "/kubelet.slice/kubelet-kubepods.slice/pod1/c2", image: "busybox:1", name: "c2" }),
      cadvisor({ namespace: "shop", pod: "web-1", container: "web", id: "/kubelet.slice/kubelet-kubepods.slice/pod2/c3", image: "nginx:1", name: "c3" }),
    ];
    expect(seriesNames(sets)).toEqual([
      "namespace=demo, pod=logger, container=helper",
      "namespace=demo, pod=logger, container=main",
      "namespace=shop, pod=web-1, container=web",
    ]);
    // The root cgroup has no Pod: the series is told apart by what it has, without its path.
    const root = cadvisor({ id: "/" });
    const named = seriesNames([...sets, root]);
    expect(named.every((n) => !n.includes("id="))).toBe(true);
    expect(named[0].startsWith("namespace=demo, pod=logger")).toBe(true);
  });

  it("noisy labels are said only when nothing else tells the series apart", () => {
    const sets = [
      { namespace: "demo", pod: "a", id: "/x/1", container_id: "c1", uid: "u1" },
      { namespace: "demo", pod: "a", id: "/x/2", container_id: "c2", uid: "u2" },
    ];
    expect(seriesNames(sets).every((n) => n.includes("id=/x/"))).toBe(true);
    expect(new Set(seriesNames(sets)).size).toBe(2);
    // Two nodes: instance, job and node are preferred in that order, and k8s_* labels too.
    expect(seriesNames([
      { node: "n1", instance: "10.0.0.1:9100", zone: "a" },
      { node: "n2", instance: "10.0.0.2:9100", zone: "b" },
    ])).toEqual(["instance=10.0.0.1:9100, node=n1", "instance=10.0.0.2:9100, node=n2"]);
    expect(seriesNames([
      { k8s_namespace_name: "demo", k8s_pod_name: "a", image: "x:1" },
      { k8s_namespace_name: "demo", k8s_pod_name: "b", image: "x:2" },
    ])).toEqual(["k8s_pod_name=a", "k8s_pod_name=b"]);
  });

  it("a single series keeps its metric name", () => {
    expect(seriesNames([{ __name__: "up", job: "api" }])).toEqual(["up"]);
    expect(seriesNames([{ job: "api" }])).toEqual([""]);
  });
});
