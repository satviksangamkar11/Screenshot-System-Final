import type { AppConfig, TestDataConfig } from '../config/schema.js';
import type { ControlDescriptor } from '../types.js';

/**
 * Dummy-value provider.
 *
 * Values are deliberately deterministic rather than random, so that two runs of
 * the same version produce comparable evidence. Value-help and lookup controls
 * are intentionally unsupported here: those obtain a real value by opening the
 * lookup and selecting a row, so that the value is always valid in the system.
 */
export class TestDataProvider {
  constructor(
    private readonly global: TestDataConfig,
    private readonly app: AppConfig,
  ) {}

  /** Resolves the value to enter into a control, or null when none applies. */
  valueFor(control: ControlDescriptor): string | null {
    const byAppLabel = this.app.testData[control.canonicalLabel];
    if (byAppLabel !== undefined) return this.expand(byAppLabel);

    const byLabel = this.global.byLabel[control.canonicalLabel];
    if (byLabel !== undefined) return this.expand(byLabel);

    /*
     * The control's own input type overrides the generic per-kind default.
     * A numeric field rejects the alphanumeric default outright, which showed
     * up as a run of validation errors across every amount field rather than
     * as a filled form.
     */
    const byType = this.valueForInputType(control.inputType);
    if (byType !== null) return byType;

    const byKind = this.global.byKind[control.kind];
    if (byKind !== undefined) return this.expand(byKind);

    return null;
  }

  /** A value the browser will actually accept for a typed input. */
  private valueForInputType(inputType: string | undefined): string | null {
    switch ((inputType ?? '').toLowerCase()) {
      case 'number':
      case 'range':
        return '1';
      case 'email':
        return 'test@example.com';
      case 'tel':
        return '0000000000';
      case 'url':
        return 'https://example.com';
      case 'date':
        return formatDate(new Date());
      case 'time':
        return '12:00';
      default:
        return null;
    }
  }

  /**
   * Resolves date tokens to concrete values.
   *
   * Supports `today`, relative offsets such as `+30d`, and ranges written as
   * `start..end`, so that date pairs stay ordered (a start date is never after
   * its end date, which enterprise forms validate).
   */
  private expand(raw: string): string {
    if (raw.includes('..')) {
      const [from = '', to = ''] = raw.split('..');
      return `${this.expandOne(from)}..${this.expandOne(to)}`;
    }
    return this.expandOne(raw);
  }

  private expandOne(token: string): string {
    const t = token.trim();
    if (t === 'today') return formatDate(new Date());

    const rel = /^([+-])(\d+)([dmy])$/.exec(t);
    if (rel) {
      const [, sign, amountStr, unit] = rel;
      const amount = Number(amountStr) * (sign === '-' ? -1 : 1);
      const d = new Date();
      if (unit === 'd') d.setDate(d.getDate() + amount);
      else if (unit === 'm') d.setMonth(d.getMonth() + amount);
      else d.setFullYear(d.getFullYear() + amount);
      return formatDate(d);
    }
    return t;
  }
}

/** ISO date, the format most Fiori date controls accept on direct input. */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Splits an expanded range value into its two halves. */
export function splitRange(value: string): [string, string] {
  const [from = '', to = ''] = value.split('..');
  return [from, to];
}
