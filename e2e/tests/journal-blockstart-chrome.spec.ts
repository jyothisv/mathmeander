// Regression guards for the "block-start chrome must be out-of-band" invariant (PM #1061): a persistent
// contentEditable=false widget at a block's START position (offset+1) corrupts text typed there — a
// block-OPENING `$…$` equation is never recognized. The fix moves all block chrome OUT of band: blockHandle
// is a hover overlay, and the typed-unit title bar + the section-fold chevron now render inside the prose
// NodeView's chrome (a sibling of contentDOM — see proseView.ts), so no widget sits at the caret position.
// The plain-block case is covered by journal-math.spec.ts; these cover the TYPED-block and FOLDED-heading
// cases the earlier suite missed.
import { expect, test } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function openToday(page: import('@playwright/test').Page, email: string): Promise<void> {
  const today = todayLocalISO();
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
}

test('a block-opening $…$ inside a THEOREM block renders — the title widget must not scramble block-start typing', async ({
  page,
}) => {
  await openToday(page, `journal-bsc-thm-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. '); // → a theorem; caret sits at the (empty) block start
  // Wait until the block IS a theorem, so the title-bar widget is present AT the block start before we type.
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toBeVisible();
  // A block-OPENING equation typed at the start of the typed block — the residual-bug case.
  await page.keyboard.type('$x^2$ end');
  await expect(page.locator('.day-editor .math-render')).toBeVisible(); // recognized + rendered (not scrambled)
  await expect(page.locator('.day-editor .katex')).toBeVisible();
  await expect(editor).toContainText('end');
});

test('a block-opening $…$ at the start of a FOLDABLE heading renders — the fold chevron must not scramble it', async ({
  page,
}) => {
  await openToday(page, `journal-bsc-fold-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('# Section'); // a heading
  await page.keyboard.press('Enter');
  await page.keyboard.type('a child paragraph'); // a descendant → the heading is FOLDABLE (its chevron shows)
  await expect(page.locator('.ProseMirror p[data-heading="true"]')).toBeVisible();
  // Caret to the heading's start, then type a block-opening equation there.
  await page.locator('.ProseMirror p[data-heading="true"]').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('$x$ ');
  await expect(page.locator('.day-editor .math-render')).toBeVisible(); // recognized + rendered (not scrambled)
  await expect(editor).toContainText('Section');
});
