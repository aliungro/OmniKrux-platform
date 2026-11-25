// The suggestions the dashboard editor offers, read once for both places that show them: the
// suggestions column and Add panel's list with no text. One catalog read, one preview batch, so a
// suggestion draws the same chart in both. With no owner (the page passes none unless the column
// or Add panel is open while editing) nothing is read and nothing runs.

import { useMemo } from "react";
import { useOwnerCatalog, type OwnerCatalogState } from "../catalog/merge";
import type { Candidate } from "./candidates";
import { MAX_SUGGESTIONS, suggestionsHeading, suggestPanels } from "./suggest";
import { usePreviews, type PreviewContext, type PreviewState } from "./usePreviews";

export interface Suggestions {
  catalog: OwnerCatalogState;
  candidates: Candidate[];
  previews: Record<string, PreviewState>;
  heading: string;
}

export function useSuggestions(ctx: PreviewContext): Suggestions {
  const catalog = useOwnerCatalog(ctx.owner);
  const read = catalog.catalog;
  const candidates = useMemo(() => (read ? suggestPanels(read).slice(0, MAX_SUGGESTIONS) : []), [read]);
  const previews = usePreviews(candidates, ctx, MAX_SUGGESTIONS);
  const heading = useMemo(() => suggestionsHeading(ctx.ownerName, candidates), [ctx.ownerName, candidates]);
  return { catalog, candidates, previews, heading };
}
