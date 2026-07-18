export type PageRequest = {
  limit: number;
  offset: number;
};

export type LoadAllPagesOptions<T> = {
  pageSize: number;
  fetchPage: (request: PageRequest) => Promise<T[]>;
  getKey: (item: T) => string;
  shouldContinue?: () => boolean;
  onFirstPage?: (items: T[]) => void;
};

/**
 * Transparently follows every backend page without imposing a global result cap.
 * A key guard prevents an endpoint that ignores offsets from looping forever.
 */
export async function loadAllPages<T>({
  pageSize,
  fetchPage,
  getKey,
  shouldContinue = () => true,
  onFirstPage,
}: LoadAllPagesOptions<T>): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("pageSize must be a positive integer");
  }

  const items: T[] = [];
  const knownKeys = new Set<string>();
  let offset = 0;

  while (shouldContinue()) {
    const page = await fetchPage({ limit: pageSize, offset });
    if (!shouldContinue()) break;

    let additions = 0;
    for (const item of page) {
      const key = getKey(item);
      if (knownKeys.has(key)) continue;
      knownKeys.add(key);
      items.push(item);
      additions += 1;
    }

    if (offset === 0) onFirstPage?.([...items]);
    offset += page.length;

    if (page.length < pageSize || additions === 0) break;
  }

  return items;
}
