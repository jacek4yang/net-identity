/**
 * Minimal DOM helpers for the framework-free UI.
 *
 * Text is always assigned through `textContent`, never `innerHTML`, so profile
 * data can never be interpreted as markup.
 */
export interface ElementOptions {
  className?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  attrs?: Record<string, string>;
  onClick?: (event: Event) => void;
  children?: readonly (Node | string | null | undefined)[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  if (options.hidden === true) node.hidden = true;
  if (options.id !== undefined) node.id = options.id;
  if (options.name !== undefined) node.setAttribute("name", options.name);
  if (options.type !== undefined) node.setAttribute("type", options.type);
  if (options.value !== undefined) node.setAttribute("value", options.value);
  if (options.placeholder !== undefined) node.setAttribute("placeholder", options.placeholder);
  if (options.min !== undefined) node.setAttribute("min", options.min);
  if (options.max !== undefined) node.setAttribute("max", options.max);
  if (options.step !== undefined) node.setAttribute("step", options.step);
  if (options.checked === true) node.setAttribute("checked", "checked");
  if (options.disabled === true) node.setAttribute("disabled", "disabled");

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }

  for (const child of options.children ?? []) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }

  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Looks up a required element, failing loudly when the markup and code disagree. */
export function requireElement<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Required element not found: ${selector}`);
  return found;
}

export function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return "never";
  return new Date(timestamp).toLocaleTimeString();
}

export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

export function formatAccuracy(accuracy: number | undefined): string {
  if (accuracy === undefined) return "unknown accuracy";
  if (accuracy >= 1000) return `±${Math.round(accuracy / 1000)} km`;
  return `±${Math.round(accuracy)} m`;
}
