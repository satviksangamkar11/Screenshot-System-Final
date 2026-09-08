import { launchChrome } from '../../src/automation/chrome-launcher.js';
import { CDPClient } from '../../src/automation/cdp-client.js';
import { CDPSession } from '../../src/automation/cdp-session.js';
import { PageShim } from '../../src/automation/page-shim.js';

/**
 * Development regression check for locator-shim.ts's selector engine — not
 * part of `src/`, so it never ships in `dist/`, and not wired to any CI step;
 * run by hand with `npm run check:selectors` after touching selector
 * resolution. Covers the Playwright selector syntax the interaction layer
 * depends on:
 * the chooser-dialog selectors (`:text-is`), the message-dialog OK button
 * (`:visible` + hasText filter) and the overlay close buttons (`:has-text`).
 */
const FIXTURE = `
<style>
  body { font: 14px sans-serif; }
  .hidden { display: none; }
</style>
<div class="sapMDialog" id="stale"><span>Organization</span></div>
<div class="sapMDialog hidden" id="hiddenDialog"><button>OK</button></div>
<div class="sapMDialog" id="live">
  <div class="sapMDialogTitle">Customer Category</div>
  <ul>
    <li><span>Organization</span></li>
    <li><span>Person</span></li>
  </ul>
  <button>OK</button>
  <button>Cancel</button>
  <button>Save and Close</button>
</div>
`;

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`   ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  if (ok) pass++; else fail++;
}

async function main() {
  const chrome = await launchChrome();
  const client = new CDPClient(chrome.debuggerUrl);
  await client.connect();

  const targets = (await client.send('Target.getTargets', {})) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const target = targets.targetInfos.find((t) => t.type === 'page')!;
  const attach = (await client.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };

  const session = new CDPSession(client, attach.sessionId, target.targetId);
  const page = new PageShim(session);
  await page.enable();
  await page.goto('data:text/html,' + encodeURIComponent(FIXTURE), {
    waitUntil: 'domcontentloaded',
  });

  console.log('\n1) :visible — the hidden dialog must not contribute');
  check('.sapMDialog count', await page.locator('.sapMDialog').count(), 3);
  check('.sapMDialog:visible count', await page.locator('.sapMDialog:visible').count(), 2);

  console.log('\n2) :text-is — resolves to the smallest element, not every ancestor');
  check(
    '#live :text-is("Organization")',
    await page.locator('#live :text-is("Organization")').count(),
    1,
  );
  check(
    'matched tag',
    await page.locator('#live :text-is("Organization")').first().evaluate((el) => el.tagName),
    'SPAN',
  );
  check(
    'exact, not substring: :text-is("Save")',
    await page.locator('#live :text-is("Save")').count(),
    0,
  );

  console.log('\n3) :has-text — substring, on the compound it is attached to');
  check(
    '#live button:has-text("Save")',
    await page.locator('#live button:has-text("Save")').count(),
    1,
  );
  check(
    '#live button:has-text("Cancel")',
    await page.locator('#live button:has-text("Cancel")').count(),
    1,
  );

  console.log('\n4) The real chooseOption selector (was failing outright)');
  const chooser = page.locator('.sapMDialog:visible :text-is("Person")').first();
  check('resolves', await chooser.count(), 1);
  await chooser.click({ timeout: 3000 });
  check('clickable', true, true);

  console.log('\n5) The real acknowledgeMessageDialogs selector + hasText filter');
  const okBtn = page
    .locator('.sapMDialog:visible button, [role="dialog"] button, dialog[open] button')
    .filter({ hasText: /^\s*(OK|Close|Continue|Dismiss|Got it)\s*$/i })
    .first();
  check('finds exactly the OK button', await okBtn.count(), 1);
  check('is the visible one', await okBtn.evaluate((el) => el.closest('.sapMDialog')!.id), 'live');

  console.log('\n6) Selector lists and plain CSS still behave');
  check('comma list', await page.locator('#live ul li, #live button').count(), 5);
  check('plain CSS untouched', await page.locator('#live button').count(), 3);
  check('child combinator', await page.locator('#live > button').count(), 3);
  check('invalid selector yields 0, not a throw', await page.locator('!!!bogus').count(), 0);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);

  await client.close();
  await chrome.close();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
