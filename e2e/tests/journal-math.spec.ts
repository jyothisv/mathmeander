// Slice 2d: inline math — Obsidian-style LIVE PREVIEW. Typing `$` opens an inline math node born-OPEN, its
// `$…$` source revealed inline in the prose flow as editable text (math mode). Crossing the closing `$` (or
// arrowing out) re-renders via KaTeX, parsed LOCALLY (the WASM build of the owned `mathmeander` grammar). A
// RENDERED equation reveals its source only on a deliberate gesture — double-click, or Backspace-after /
// Delete-before — never on a single click. Source is visible ONLY while the caret is inside.
import { expect, test } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function openToday(page: import('@playwright/test').Page, email: string): Promise<string> {
  const today = todayLocalISO();
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  return today;
}

const put200 = (r: { url(): string; request(): { method(): string }; status(): number }): boolean =>
  r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200;

test('inline math: $ opens source inline → crossing $ renders with KaTeX → persists across reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-math-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('Energy is ');
  await page.keyboard.type('$'); // born-open inline math (source revealed in flow)
  await expect(math).toHaveClass(/math-open/);
  await page.keyboard.type('E = m c^2'); // type the source directly — the caret is inside the math
  await page.keyboard.type('$'); // the closing delimiter → exit + render

  await expect(math).not.toHaveClass(/math-open/); // back to rendered
  await expect(page.locator('.day-editor .katex')).toBeVisible(); // KaTeX rendered it
  // real-WASM boundary: the mathmeander source `c^2` was transpiled to LaTeX `c^{2}` (in KaTeX's MathML
  // annotation) — i.e. the actual surface→KaTeX transpile ran in the browser, not a stub.
  await expect(page.locator('.day-editor .katex annotation').first()).toContainText('c^{2}');
  await expect(editor).toContainText('Energy is');

  await page.waitForResponse(put200, { timeout: 15000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  // persisted + re-rendered from the canonical surface
  await expect(page.locator('.day-editor .katex')).toBeVisible();
  await expect(editor).toContainText('Energy is');
});

test('a $ then Escape leaves a literal dollar sign (no empty math node)', async ({ page }) => {
  await openToday(page, `journal-math-lit-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('costs ');
  await page.keyboard.type('$'); // born-open empty math
  await expect(page.locator('.inline-math')).toHaveClass(/math-open/);
  await page.keyboard.press('Escape'); // empty → a literal `$`, no math node
  await expect(page.locator('.inline-math')).toHaveCount(0);
  await expect(page.locator('.day-editor .katex')).toHaveCount(0);
  await expect(editor).toContainText('costs $');
});

test('double-click reveals the source; a single click does not', async ({ page }) => {
  await openToday(page, `journal-math-dbl-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$x^2');
  await page.keyboard.type('$'); // close → rendered
  await expect(math).not.toHaveClass(/math-open/);
  await expect(page.locator('.day-editor .katex')).toBeVisible();

  await math.click(); // single click → stays rendered
  await expect(math).not.toHaveClass(/math-open/);

  await math.dblclick(); // double click → source revealed
  await expect(math).toHaveClass(/math-open/);
  await expect(math.locator('.math-source')).toBeVisible();
});

test('clicking inside the revealed source keeps it open (caret placement, not collapse)', async ({
  page,
}) => {
  await openToday(page, `journal-math-clicksrc-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$a + b + c');
  await page.keyboard.type('$'); // close → rendered
  await math.dblclick(); // open the source
  await expect(math).toHaveClass(/math-open/);

  // a single click INSIDE the source must place the caret there, NOT collapse back to rendered
  await math.locator('.math-source').click();
  await expect(math).toHaveClass(/math-open/);
  await expect(math.locator('.math-source')).toBeVisible();
});

test('deleting all the source keeps an empty-open math (no stray char, no collapse)', async ({
  page,
}) => {
  await openToday(page, `journal-math-delempty-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$ab'); // born-open, content "ab"
  await expect(math).toHaveClass(/math-open/);
  await page.keyboard.press('Backspace'); // → "a"
  await page.keyboard.press('Backspace'); // → empty (the last-char delete is the buggy case)

  await expect(math).toHaveClass(/math-open/); // still open with the caret inside (the born-open state)
  await expect(math.locator('.math-source')).toHaveText(''); // empty — the deleted char does NOT reappear
  await expect(math.locator('.katex')).toHaveCount(0); // did not collapse to the rendered view
});

test('opening + closing a rendered equation with no edit makes no save (no churn-PUT)', async ({
  page,
}) => {
  await openToday(page, `journal-math-nochurn-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$x^2');
  await page.keyboard.type('$'); // rendered
  await page.waitForResponse(put200); // the real edit saves
  await page.waitForTimeout(900); // let any trailing flush settle

  let puts = 0;
  const onResp = (r: {
    url(): string;
    request(): { method(): string };
    status(): number;
  }): void => {
    if (put200(r)) puts++;
  };
  page.on('response', onResp);
  await math.dblclick(); // open — a selection change only
  await expect(math).toHaveClass(/math-open/);
  await page.keyboard.press('Escape'); // close — a selection change only
  await expect(math).not.toHaveClass(/math-open/);
  await page.waitForTimeout(1100); // past the 800ms flush debounce
  page.off('response', onResp);
  expect(puts).toBe(0); // open/close with no content change must not write
});

test('Backspace just after a rendered equation opens its source (does not delete it)', async ({
  page,
}) => {
  await openToday(page, `journal-math-bksp-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$a + b');
  await page.keyboard.type('$'); // close → rendered, caret now right after the equation
  await expect(math).not.toHaveClass(/math-open/);

  await page.keyboard.press('Backspace'); // right after a rendered eqn → OPEN it, don't delete
  await expect(math).toHaveCount(1); // still present
  await expect(math).toHaveClass(/math-open/); // its source is revealed
  await expect(math.locator('.math-source')).toContainText('a + b');
});

test('unparseable math is preserved, never dropped (§2.2)', async ({ page }) => {
  await openToday(page, `journal-math-bad-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const math = page.locator('.inline-math');
  await editor.click();
  await page.keyboard.type('$x ^^');
  await page.keyboard.type('$'); // close
  await expect(math).toHaveCount(1); // the input was NOT dropped

  await math.dblclick(); // reveal the source
  await expect(math.locator('.math-source')).toContainText('x ^^'); // exactly what was typed, preserved
});
