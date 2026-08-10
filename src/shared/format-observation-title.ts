/**
 * Prefix an Observation's title with its git author. Display-layer only —
 * a stored title must never pass through this function before being
 * written to the database (that would corrupt the search index and embeddings).
 */
export function formatObservationTitle(
  title: string | null | undefined,
  gitUser: string | null | undefined
): string {
  const resolvedTitle = title && title.trim() !== '' ? title : 'Untitled';
  if (!gitUser || gitUser.trim() === '') return resolvedTitle;
  return `by ${gitUser}, ${resolvedTitle}`;
}
