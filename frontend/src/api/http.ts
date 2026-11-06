async function fail(res: Response): Promise<never> {
  let detail: string | undefined;
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") detail = body.detail;
  } catch {
    // body was not JSON
  }
  throw new Error(detail ?? `${res.status} ${res.statusText}`.trim());
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export async function postEmpty(path: string): Promise<void> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) return fail(res);
}
