/**
 * Parser for Web Dynpro ABAP's `lsdata` attribute.
 *
 * The Lightspeed renderer serialises each control's client-side metadata as a
 * single-quoted, positional array literal — not valid JSON (single-quoted,
 * commas may be doubled for a skipped slot) and not safe to run through
 * `JSON.parse` or `eval`/`Function`. This is a hand-written tokenizer that
 * only ever recognises the shape it is documented to handle; anything else
 * comes back `null` rather than throwing, since a malformed or
 * future-version attribute should be skipped by `probe.ts`, not crash
 * discovery.
 *
 * This is the ONLY module that parses `lsdata` — every other file in this
 * adapter works with the typed `LsData` this returns.
 */

/** Typed, positional fields decoded from one `lsdata` attribute. */
export interface LsDataProperties {
  id: string;
  label: string;
  value: string;
  enabled: boolean;
  visible: boolean;
  readOnly: boolean;
  required: boolean;
  /** DDIC-ish data type hint, e.g. `'DATE'`, `'STRING'`, or `''` when absent. */
  dataType: string;
  /** True when this control's own metadata flags an F4/search-help affordance. */
  valueHelp: boolean;
}

export interface LsData {
  controlType: string;
  properties: LsDataProperties;
}

/**
 * Splits the contents of `[...]` into its comma-separated single-quoted
 * string tokens, tolerating an empty slot (`,,`) and a trailing comma.
 * Returns `null` for anything that isn't cleanly tokenizable — an
 * unterminated quote, or a bare (non-quoted, non-empty) slot, which this
 * format never produces.
 */
function tokenize(inner: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const n = inner.length;

  // An all-whitespace body is zero fields, not one empty field.
  if (inner.trim().length === 0) return [];

  while (i < n) {
    while (i < n && /\s/.test(inner[i]!)) i++;
    if (i >= n) break;

    if (inner[i] === ',') {
      tokens.push('');
      i++;
      continue;
    }

    if (inner[i] !== "'") {
      // A bare, unquoted slot is not part of this format.
      return null;
    }

    i++; // consume opening quote
    let buf = '';
    let closed = false;
    while (i < n) {
      const c = inner[i]!;
      if (c === '\\' && i + 1 < n) {
        buf += inner[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") {
        closed = true;
        i++;
        break;
      }
      buf += c;
      i++;
    }
    if (!closed) return null;
    tokens.push(buf);

    while (i < n && /\s/.test(inner[i]!)) i++;
    if (i >= n) break;
    if (inner[i] === ',') {
      i++;
      continue;
    }
    // Anything other than a comma or end-of-string after a closed string is malformed.
    return null;
  }

  return tokens;
}

const FLAG_TRUE = new Set(['X', 'x', 'true', 'TRUE']);

function isFlagSet(v: string | undefined): boolean {
  return v !== undefined && FLAG_TRUE.has(v);
}

/**
 * Parses one `lsdata` attribute value into typed control metadata.
 *
 * Positional format (all slots optional past the first, missing slots
 * default): `[controlType, id, label, value, enabled, visible, readOnly,
 * required, dataType, valueHelp]`, where the flag slots (`enabled`,
 * `visible`, `readOnly`, `required`, `valueHelp`) use `'X'` for true and
 * `''` for false. `enabled` and `visible` default to `true` when the slot is
 * missing entirely (an absent flag reads as "nothing said otherwise"); the
 * rest default to `false`/`''`.
 *
 * Returns `null` — never throws — when `raw` is empty, not wrapped in
 * `[...]`, contains an unterminated string, or has no control type in the
 * first slot.
 */
export function parseLsdata(raw: string | null | undefined): LsData | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  const inner = trimmed.slice(1, -1);
  const tokens = tokenize(inner);
  if (tokens === null) return null;

  const controlType = tokens[0] ?? '';
  if (!controlType) return null;

  return {
    controlType,
    properties: {
      id: tokens[1] ?? '',
      label: tokens[2] ?? '',
      value: tokens[3] ?? '',
      enabled: tokens[4] === undefined ? true : isFlagSet(tokens[4]),
      visible: tokens[5] === undefined ? true : isFlagSet(tokens[5]),
      readOnly: isFlagSet(tokens[6]),
      required: isFlagSet(tokens[7]),
      dataType: tokens[8] ?? '',
      valueHelp: isFlagSet(tokens[9]),
    },
  };
}
