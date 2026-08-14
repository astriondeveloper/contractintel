/**
 * The smallest HTML layer that is still safe.
 *
 * Everything interpolated into a page is escaped unless it is itself the result of
 * `html` or `raw`. That rule is the whole design: a page cannot accidentally emit an
 * unescaped vendor name, and the corpus is full of names carrying quotes, ampersands
 * and angle brackets.
 *
 * There is no template engine and no client framework here on purpose. Spec section 16
 * asks for one container with configuration from environment variables; a server that
 * renders strings keeps that promise with no build step.
 */

/** Markup that has already been escaped. The only thing `html` will not escape again. */
export interface Html {
  readonly __html: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for HTML text or an attribute value. */
export function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** Mark a string as already-safe markup. Use only on markup this codebase produced. */
export function raw(markup: string): Html {
  return { __html: markup };
}

function isHtml(value: unknown): value is Html {
  return typeof value === 'object' && value !== null && '__html' in value;
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (isHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

/** Tagged template for markup. Interpolations are escaped unless they are `Html`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1]!;
  }
  return raw(out);
}

/** Render an `Html` value to the string that goes on the wire. */
export function toString(node: Html): string {
  return node.__html;
}
