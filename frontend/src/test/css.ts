import { readFileSync } from "node:fs";

/**
 * Vitest stubs CSS imports. This returns a stylesheet's real rules with its module class names
 * swapped in, so a test can inject it and check computed styles; pixel layout remains a browser check.
 */
export function componentCss(base: string, file: string, classes: Record<string, string>): string {
  // `base` is the caller's import.meta.url. Kept apart from `file`: Vite rewrites a literal
  // `new URL("./x", import.meta.url)` into an asset URL that isn't a file.
  return readFileSync(new URL(file, base), "utf8").replace(/\.([a-zA-Z][\w-]*)/g,
    (selector, name: string) => classes[name] ? `.${classes[name].split(" ")[0]}` : selector);
}
