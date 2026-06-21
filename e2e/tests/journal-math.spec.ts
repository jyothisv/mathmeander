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
