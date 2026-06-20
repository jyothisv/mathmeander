// Slice 2c-2: type cues. Typing a leading cue (`Thm. `) at a block start makes that unit a theorem —
// the cue text is stripped, the block shows its type, and the type is persisted via the canonical
// set_unit_type op (NOT the prose delta). End-to-end: ProseMirror inputRule → PUT /content (type=null)
// → POST /ops/set-unit-type → core → Postgres; and Backspace-at-start clears it back to plain.
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

test('type cue: `Thm.` makes a theorem (cue stripped, type persisted via set_unit_type)', async ({
  page,
}) => {
  await openToday(page, `journal-type-${Date.now()}@mathmeander.local`);

  const putContent = page.waitForResponse(
    (r) => r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 15000 },
  );
  const postType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );

  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The trailing space after "Thm." triggers the input rule; the rest becomes the unit's prose.
  await page.keyboard.type('Thm. The fundamental theorem.');

  await putContent; // prose created (type=null)
  await postType; // type set to theorem

  // The cue text is gone; the block is marked as a theorem.
  const typed = page.locator('.ProseMirror p[data-unit-type="theorem"]');
  await expect(typed).toBeVisible();
  await expect(typed).toHaveText('The fundamental theorem.');
  await expect(page.locator('.ProseMirror')).not.toContainText('Thm.');

  // Survives reload (the type round-trips from the server projection).
  await page.reload();
  const after = page.locator('.ProseMirror p[data-unit-type="theorem"]');
  await expect(after).toBeVisible();
  await expect(after).toHaveText('The fundamental theorem.');
});

test('Backspace at a typed block start clears the type back to plain', async ({ page }) => {
  await openToday(page, `journal-type-clear-${Date.now()}@mathmeander.local`);

  const editor = page.locator('.ProseMirror');
  await editor.click();
  const setType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );
  await page.keyboard.type('Def. A group is a set with one operation.');
  await setType;
  await expect(page.locator('.ProseMirror p[data-unit-type="definition"]')).toBeVisible();

  // Move to the very start of the block and clear the type (Backspace-at-start gesture).
  const clearType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await clearType;

  // Back to plain — no type label, text intact.
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).toContainText('A group is a set with one operation.');
});
