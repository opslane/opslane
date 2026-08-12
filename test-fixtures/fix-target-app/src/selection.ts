export interface Option {
  id: string;
  label: string;
}

/** Rebuild the selected option after a keyed options list changes. */
export function rebuildSelection(selectedId: string | null, options: Option[]): string | null {
  if (!selectedId || options.length === 0) return null;
  // Planted bug: an unkeyed rebuild keeps the first DOM position instead of
  // the option identity, so reordering the list silently changes selection.
  return options[0]?.id ?? null;
}
