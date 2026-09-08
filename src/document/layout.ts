/**
 * Formatting constants measured directly from the reference documents.
 *
 * These are not stylistic choices: they were read out of the OOXML of the
 * supplied comparison documents so that generated output is visually
 * indistinguishable from the hand-made originals.
 */

/** Document title: centred, 36pt (w:sz 72 half-points). */
export const TITLE_SIZE_HALF_POINTS = 72;

/** Version heading ("Old Version" / "New Version"). */
export const VERSION_HEADING_SIZE_HALF_POINTS = 36;

/** Documentation point labels: red, 16pt (w:sz 32 half-points). */
export const LABEL_SIZE_HALF_POINTS = 32;

/** The red used for every label in the reference documents. */
export const LABEL_COLOR = 'FF0000';

/**
 * Screenshot width in EMU.
 *
 * The reference documents use a fixed width with variable height, i.e. images
 * are width-locked and scaled to preserve aspect ratio. Observed values were
 * 5731510 and 5861050 EMU; the midpoint is used here.
 */
export const IMAGE_WIDTH_EMU = 5_800_000;

/** EMU per inch, per the OOXML specification. */
const EMU_PER_INCH = 914_400;

/** Pixels per inch assumed by the docx library's image sizing. */
const PX_PER_INCH = 96;

/** Screenshot width in pixels, as the docx library expects. */
export const IMAGE_WIDTH_PX = Math.round(
  (IMAGE_WIDTH_EMU / EMU_PER_INCH) * PX_PER_INCH,
);

/** The label used for the final full-page capture of every page. */
export const FULL_PAGE_LABEL = 'Full Page';

/** Heading text for each version section. */
export const VERSION_HEADINGS = {
  old: 'Old Version',
  new: 'New Version',
} as const;

/**
 * Scales an image to the fixed document width, preserving aspect ratio.
 */
export function scaleToWidth(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    // Fall back to the 16:9 viewport the capture stage uses.
    return {
      width: IMAGE_WIDTH_PX,
      height: Math.round((IMAGE_WIDTH_PX * 9) / 16),
    };
  }
  return {
    width: IMAGE_WIDTH_PX,
    height: Math.round((IMAGE_WIDTH_PX * naturalHeight) / naturalWidth),
  };
}
