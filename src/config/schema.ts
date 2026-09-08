import { z } from 'zod';

/**
 * Configuration schemas.
 *
 * All config is validated at load time so that a malformed YAML file fails
 * immediately with a clear message rather than midway through a long capture run.
 */

/** Safety policy governing which buttons the explorer is allowed to click. */
export const SafetyPolicySchema = z.object({
  /**
   * Button labels that must never be clicked. These create real business
   * documents in the target system. Matched case-insensitively as whole words.
   */
  denyLabels: z
    .array(z.string())
    .default([
      'save',
      'submit',
      'delete',
      'remove',
      'post',
      'confirm',
      'approve',
      'reject',
      'send',
      'create',
      'release',
      'cancel order',
      'complete',
    ]),
  /**
   * Button labels that are safe to click even though they perform an action.
   * These are read-only queries needed to reach result pages.
   */
  allowLabels: z
    .array(z.string())
    .default(['search', 'execute', 'go', 'refresh', 'filter', 'apply']),
  /** When true, deny-list violations abort the run instead of being skipped. */
  strict: z.boolean().default(false),
});

/** Limits that keep a recursive crawl bounded. */
export const BudgetSchema = z.object({
  /** Milliseconds to wait for any single control interaction. */
  controlTimeoutMs: z.number().int().positive().default(20_000),
  /**
   * Maximum controls processed on a single page. Unset by default — a page
   * is fully explored regardless of how many controls it has. Set this only
   * where a run genuinely needs bounding (e.g. a fixture deliberately
   * testing the budget-stop mechanism).
   */
  maxControlsPerPage: z.number().int().positive().optional(),
  /** Maximum pages visited in one run. */
  maxPages: z.number().int().positive().default(50),
  /** Maximum recursion depth for nested branches. */
  maxDepth: z.number().int().positive().default(6),
  /** Wall-clock cap for the whole run. */
  maxRunMs: z.number().int().positive().default(90 * 60_000),
  /** Milliseconds to wait for the UI to settle after an interaction. */
  stabilityTimeoutMs: z.number().int().positive().default(15_000),
  /**
   * Milliseconds to wait for a control to become interactable (visible,
   * enabled, not read-only, not covered by a leftover overlay) before an
   * interaction is even attempted. Deliberately short: this replaces waiting
   * out the full `controlTimeoutMs` for a control that was never going to
   * become fillable, which otherwise repeats for every control blocked by the
   * same underlying cause.
   */
  editabilityCheckMs: z.number().int().positive().default(5_000),
  /**
   * Milliseconds to wait for an application to finish its initial render.
   *
   * Enterprise Fiori applications routinely need well over a minute: the shell
   * appears quickly, then the component loads, the route resolves and data is
   * fetched. Capturing before this completes photographs an empty shell.
   */
  appReadyTimeoutMs: z.number().int().positive().default(180_000),
});

/** One application version's entry point. */
export const VersionConfigSchema = z.object({
  url: z.string().url(),
  /** Optional storageState file; defaults to auth/.storage/<app>-<version>.json */
  storageState: z.string().optional(),
});

export const AppConfigSchema = z.object({
  /** Slug used on the command line and for output paths. */
  name: z.string().min(1),
  /** Title printed at the top of the generated document. */
  title: z.string().min(1),
  /**
   * Whether a saved sign-in session is required. Set false for applications
   * reachable without authentication (for example IP-allowlisted internal
   * hosts), which lets capture run without a prior `login` step.
   */
  requiresAuth: z.boolean().default(true),
  versions: z.object({
    old: VersionConfigSchema.optional(),
    new: VersionConfigSchema.optional(),
  }),
  safety: SafetyPolicySchema.default({}),
  budgets: BudgetSchema.default({}),
  /**
   * Controls excluded from documentation by label, for the rare case where a
   * structurally-interactive control is not a meaningful documentation point.
   */
  excludeLabels: z.array(z.string()).default([]),
  /** Per-app label overrides layered on top of the global lexicon. */
  lexicon: z.record(z.string(), z.string()).default({}),
  /** Per-app dummy values keyed by canonical label. */
  testData: z.record(z.string(), z.string()).default({}),
  /**
   * Automatic fills every control itself, exactly as it always has. Manual
   * discovers, classifies and navigates identically, but pauses before each
   * control and waits for the operator to fill it in a visible browser
   * window, confirmed through the web UI. Defaults to automatic so existing
   * callers (CLI runs, YAML-configured apps) keep working unchanged.
   */
  dataEntryMode: z.enum(['automatic', 'manual']).default('automatic'),
});

export const LexiconSchema = z.object({
  /** Maps a raw label (lowercased, whitespace-collapsed) to its canonical form. */
  canonical: z.record(z.string(), z.string()).default({}),
});

export const TestDataSchema = z.object({
  /** Default value per control kind. */
  byKind: z.record(z.string(), z.string()).default({}),
  /** Value per canonical label; takes precedence over byKind. */
  byLabel: z.record(z.string(), z.string()).default({}),
});

export type SafetyPolicy = z.infer<typeof SafetyPolicySchema>;
export type Budgets = z.infer<typeof BudgetSchema>;
export type VersionConfig = z.infer<typeof VersionConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type Lexicon = z.infer<typeof LexiconSchema>;
export type TestDataConfig = z.infer<typeof TestDataSchema>;
