/**
 * WebGUI-specific deny matching.
 *
 * ITS toolbar buttons are frequently icon-only: the button's own visible
 * text is empty (a sprite/icon glyph), so its resolved label carries no
 * meaning for the generic label match in `interaction/safety.ts` — but ITS
 * still names the button's purpose in its `title` attribute (a real "Save"
 * tooltip on a floppy-disk icon). This checks that title text against the
 * deny list independently of whatever visible label discovery resolved.
 *
 * Whole-word match, same semantics as the generic check this supplements —
 * "Save" blocks a Save button without also blocking something unrelated
 * that merely contains the substring.
 */
export function matchesDenyLabel(
  title: string,
  denyList: readonly string[],
): string | undefined {
  const text = title.trim().toLowerCase();
  if (!text) return undefined;

  return denyList.find((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (text === r) return true;
    const pattern = new RegExp(`\\b${escapeRegex(r)}\\b`);
    return pattern.test(text);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
