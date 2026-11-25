// An import that failed right after setup created its project, while the install review opens over
// that project: the project page says so (once, as it opens) and offers the Import page. Held in
// memory only, per project id; the words are the backend's refusal (never a secret).

const waiting = new Map<string, string>();

export const importFailedWords = (message: string) => `The project was created, but its dashboards weren't imported: ${message}`;

/** Says, on the project's page as it opens next, that its import failed. */
export function noteImportFailed(projectId: string, message: string): void {
  waiting.set(projectId, message);
}

/** The failure waiting for this project, if any. */
export const importFailure = (projectId: string): string | null => waiting.get(projectId) ?? null;

/** The project page has shown it. */
export function clearImportFailure(projectId: string): void {
  waiting.delete(projectId);
}
