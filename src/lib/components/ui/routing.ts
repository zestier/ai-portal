export function buildSort(
  sortBy: string,
  sortPartition: string,
): Record<string, string> | undefined {
  const sort: Record<string, string> = {};
  if (sortBy !== "inherit" && sortBy !== "") sort.by = sortBy;
  if (sortPartition !== "inherit" && sortPartition !== "") {
    sort.partition = sortPartition;
  }
  return Object.keys(sort).length ? sort : undefined;
}
