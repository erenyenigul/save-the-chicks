/** Looks up an element that index.html is expected to provide. */
export function element<T extends Element = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found;
}
