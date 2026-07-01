// The ⋮⋮ block handle — a hover-tracked overlay in <body> (not a per-block widget). Covers the rewritten
// feature end-to-end: hover reveals the grip, clicking it opens Move up/down and reorders the block, and the
// glyph never leaks into copied text (it lives outside the editable content).
import { expect, test } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

test('the ⋮⋮ handle: hover reveals it, clicking it reorders the block, and it never leaks into copy', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openToday(page, `journal-handle-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // Two prose units (a blank line starts a new one).
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');

  // Hover the FIRST block → the overlay handle appears (it's a single fixed element in <body>, not per-block).
  await editor.locator('p').first().hover();
  const handle = page.locator('.mm-block-handle');
  await expect(handle).toBeVisible();

  // Click it → the menu; Move the first block DOWN → order becomes beta, alpha.
  await handle.click();
  await page.getByRole('button', { name: 'Move down' }).click();
  await expect(editor.locator('p').first()).toContainText('beta');
  await expect(editor.locator('p').nth(1)).toContainText('alpha');

  // Copy the document → the ⋮⋮ grip is out-of-band, so it is NOT in the copied text.
  await editor.click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`);
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+c`);
  const clip = await page.evaluate(() =>
    (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
  );
  expect(clip).not.toContain('⋮');
});
