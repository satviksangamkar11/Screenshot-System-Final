import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from 'docx';
import type { AiSummaryResult } from '../doc-intelligence/index.js';
import type { Evidence, RunTrace, VersionId } from '../types.js';
import {
  FULL_PAGE_LABEL,
  LABEL_COLOR,
  LABEL_SIZE_HALF_POINTS,
  TITLE_SIZE_HALF_POINTS,
  VERSION_HEADINGS,
  VERSION_HEADING_SIZE_HALF_POINTS,
  scaleToWidth,
} from './layout.js';
import { readPngSize } from './png.js';
import { buildPageTree, validatePageTree, type PageNode } from './tree.js';
import { log } from '../util/logger.js';

/**
 * Word document assembly.
 *
 * A pure function of the captured traces: it never touches a browser, so
 * formatting can be corrected and the document regenerated without repeating a
 * capture run.
 *
 * The document follows the application's actual navigation hierarchy rather
 * than a flat label list:
 *
 *   H1  Application title
 *   H2  Version ("Old Version" / "New Version")
 *   H3  Page or top-level branch (e.g. a chooser option, a tab)
 *   H4  Sub-page or dialog reached from that page
 *   —   Interaction points (label + screenshot) as body content under
 *       whichever heading is current; deeper nesting than H4 falls back to a
 *       bold paragraph rather than an invalid heading jump.
 *
 * Internal classifications (matched, changed, confidence) are deliberately
 * absent; they belong to the execution report, not to the deliverable.
 */

export interface BuildOptions {
  title: string;
  /** Traces keyed by version. Either may be absent. */
  traces: Partial<Record<VersionId, { trace: RunTrace; runDir: string }>>;
  outputPath: string;
  /** When provided, an "AI Summary" section is appended as the last page of the document. */
  aiSummary?: AiSummaryResult;
}

/** Deepest level with a real Word heading style; beyond this, use bold text. */
const MAX_HEADING_LEVEL = 4;

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

export async function buildDocument(opts: BuildOptions): Promise<string> {
  const children: Paragraph[] = [];

  // H1 — document title.
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({ text: opts.title, size: TITLE_SIZE_HALF_POINTS, bold: true }),
      ],
    }),
  );

  for (const version of ['old', 'new'] as VersionId[]) {
    const entry = opts.traces[version];
    if (!entry) continue;

    const root = buildPageTree(entry.trace.evidence);
    const problems = validatePageTree(root);
    for (const problem of problems) log.warn(`document hierarchy: ${problem}`);

    // H2 — version.
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 },
        children: [
          new TextRun({
            text: VERSION_HEADINGS[version],
            size: VERSION_HEADING_SIZE_HALF_POINTS,
            bold: true,
          }),
        ],
      }),
    );

    await renderNode(children, root, entry.runDir);
  }

  // AI Summary — appended as the last section when the caller supplies it.
  if (opts.aiSummary) {
    renderAiSummary(children, opts.aiSummary);
  }

  const doc = new Document({
    creator: 'UI Documentation Engine',
    title: opts.title,
    description: 'Automatically captured UI evidence',
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  await writeFile(opts.outputPath, buffer);
  return opts.outputPath;
}

/**
 * Renders one page node and its children, depth-first.
 *
 * A page's own points and Full Page always appear before its children's
 * content, which mirrors capture order: the explorer photographs a page to
 * completion before descending into anything it links to.
 */
async function renderNode(
  out: Paragraph[],
  node: PageNode,
  runDir: string,
): Promise<void> {
  // The root has no heading of its own — its content (if any) sits directly
  // under the version heading, matching applications with no branching.
  if (node.depthBeyondRoot > 0) {
    const level = Math.min(2 + node.depthBeyondRoot, MAX_HEADING_LEVEL);
    out.push(headingOrBold(node.name, level));
  }

  /*
   * Tabs ("Form", "Copy", "Attachments") are sections of this page, not child
   * pages (see Explorer.processTabs), so they only ever show up as a field on
   * this node's own evidence -- never as a page of their own. A heading level
   * is reserved for them only when this page actually has tabs; a page with
   * none keeps the section level it always had, so plain single-page
   * applications are unaffected.
   */
  const hasTabs = node.ownEvidence.some((e) => e.tab);
  const tabLevel = hasTabs
    ? node.depthBeyondRoot === 0
      ? 3
      : node.depthBeyondRoot === 1
        ? 4
        : null
    : null;

  // Sections (a tab's fieldset groupings, e.g. "General", "Copy Section") get
  // their own heading only when a level is actually free; once this page's
  // own heading (and, when present, its tab heading) has claimed it, a
  // section becomes a bold label instead.
  const sectionLevel = hasTabs
    ? node.depthBeyondRoot === 0
      ? 4
      : null
    : node.depthBeyondRoot === 0
      ? 3
      : node.depthBeyondRoot === 1
        ? 4
        : null;

  await renderEvidence(out, node.ownEvidence, runDir, tabLevel, sectionLevel);

  for (const child of node.children) {
    await renderNode(out, child, runDir);
  }
}

/**
 * Renders one page's own points, grouping consecutive items by tab
 * ("Form Section", "Copy Section", "Attachments Section") and then, within a
 * tab, by fieldset section ("General").
 */
async function renderEvidence(
  out: Paragraph[],
  evidence: Evidence[],
  runDir: string,
  tabLevel: number | null,
  sectionLevel: number | null,
): Promise<void> {
  let lastTab: string | undefined;
  let lastSection: string | undefined;

  for (const ev of evidence) {
    const label = documentLabel(ev);
    if (label === null) continue;

    if (ev.tab && ev.tab !== lastTab) {
      out.push(
        tabLevel !== null
          ? headingOrBold(`${ev.tab} Section`, tabLevel)
          : boldParagraph(`${ev.tab} Section`),
      );
      lastTab = ev.tab;
      // A fieldset name ("General") can legitimately repeat across tabs
      // ("Standard" in Copy, say); starting a new tab must not suppress its
      // heading just because an earlier tab happened to end on that name.
      lastSection = undefined;
    }

    if (ev.section && ev.section !== lastSection) {
      out.push(
        sectionLevel !== null
          ? headingOrBold(ev.section, sectionLevel)
          : boldParagraph(ev.section),
      );
      lastSection = ev.section;
    }

    out.push(labelParagraph(label));

    /*
     * A whole-page capture arrives as consecutive screenfuls; they all belong
     * to this one point and follow its single label, exactly as the reference
     * documents present their multi-screen "Full Page".
     */
    for (const shot of [ev.screenshotPath, ...(ev.additionalScreenshots ?? [])]) {
      const img = await imageParagraph(runDir, shot);
      if (img) out.push(img);
    }
  }
}

/**
 * The text printed above a screenshot.
 *
 * The initial full-page capture carries no label in the reference documents —
 * only interaction points and the closing "Full Page" do — so it is skipped.
 */
function documentLabel(ev: Evidence): string | null {
  if (ev.interactionType === 'initialFullPage') return null;
  if (ev.interactionType === 'finalFullPage') return FULL_PAGE_LABEL;
  return ev.canonicalLabel || ev.label || null;
}

/** A real Word heading up to H4; a bold paragraph for anything deeper. */
function headingOrBold(text: string, level: number): Paragraph {
  if (level <= MAX_HEADING_LEVEL) {
    return new Paragraph({
      heading: HEADING_BY_LEVEL[level],
      spacing: { before: 300, after: 150 },
      children: [new TextRun({ text, bold: true })],
    });
  }
  return boldParagraph(text);
}

function boldParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 250, after: 120 },
    children: [new TextRun({ text, bold: true })],
  });
}

const OVERALL_CHANGE_LABELS: Record<string, string> = {
  no_change: 'No meaningful UI change',
  minor: 'Minor UI change',
  moderate: 'Moderate UI change',
  major: 'Major UI change',
};

const CATEGORY_LABELS: Record<string, string> = {
  added: 'ADDED',
  removed: 'REMOVED',
  changed: 'CHANGED',
  state: 'STATE',
  structure: 'STRUCTURE',
};

/**
 * Appends the AI UI Documentation section as the final page of the document.
 *
 * Single version: "AI UI DOCUMENTATION" heading + bullet points.
 * Comparison:     "AI UI COMPARISON" heading + categorised bullet points
 *                 + optional "OVERALL UI CHANGE" sub-heading.
 *
 * A page break precedes the section so it starts on a clean page.
 */
function renderAiSummary(out: Paragraph[], summary: AiSummaryResult): void {
  // Page break before the AI section.
  out.push(
    new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [new PageBreak()],
    }),
  );

  const heading = summary.type === 'comparison' ? 'AI UI COMPARISON' : 'AI UI DOCUMENTATION';

  out.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      spacing: { before: 0, after: 300 },
      children: [
        new TextRun({ text: heading, size: TITLE_SIZE_HALF_POINTS, bold: true }),
      ],
    }),
  );

  for (const point of summary.points) {
    // Build the bullet text. For comparison mode, prefix with "CATEGORY — ".
    let text = point.text;
    if (summary.type === 'comparison' && point.category) {
      const label = CATEGORY_LABELS[point.category] ?? point.category.toUpperCase();
      text = `${label} — ${text}`;
    }

    out.push(
      new Paragraph({
        spacing: { before: 80, after: 80 },
        bullet: { level: 0 },
        children: [new TextRun({ text, size: LABEL_SIZE_HALF_POINTS })],
      }),
    );
  }

  // OVERALL UI CHANGE — comparison only.
  if (summary.type === 'comparison' && summary.overallChange) {
    const { level, text } = summary.overallChange;
    const levelLabel = OVERALL_CHANGE_LABELS[level] ?? level;

    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 120 },
        children: [
          new TextRun({ text: 'OVERALL UI CHANGE', size: VERSION_HEADING_SIZE_HALF_POINTS, bold: true }),
        ],
      }),
    );
    out.push(
      new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [new TextRun({ text: levelLabel, size: LABEL_SIZE_HALF_POINTS, bold: true })],
      }),
    );
    if (text) {
      out.push(
        new Paragraph({
          spacing: { before: 40, after: 40 },
          children: [new TextRun({ text, size: LABEL_SIZE_HALF_POINTS })],
        }),
      );
    }
  }
}

/** Red 16pt label, matching the reference documents. */
function labelParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        color: LABEL_COLOR,
        size: LABEL_SIZE_HALF_POINTS,
      }),
    ],
  });
}

/** Embeds a screenshot at the fixed document width, preserving aspect ratio. */
async function imageParagraph(
  runDir: string,
  screenshotPath: string,
): Promise<Paragraph | null> {
  const abs = path.join(runDir, screenshotPath);
  if (!existsSync(abs)) {
    log.warn(`missing screenshot, skipping: ${screenshotPath}`);
    return null;
  }

  const data = await readFile(abs);
  const size = readPngSize(data);
  const scaled = scaleToWidth(size?.width ?? 0, size?.height ?? 0);

  return new Paragraph({
    spacing: { after: 200 },
    children: [
      new ImageRun({
        type: 'png',
        data,
        transformation: { width: scaled.width, height: scaled.height },
      }),
    ],
  });
}
