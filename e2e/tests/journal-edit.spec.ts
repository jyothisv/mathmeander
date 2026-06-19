// Slice 2c-1: author prose in a journal day through the real editor → it persists. Proves the
// from-nothing authoring path (an empty day → typed paragraphs → reload survives) end-to-end:
// browser ProseMirror → projection/flush → save_content → core → Postgres.
import { expect, test } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

test('journal editor: author prose, autosave, survive reload', async ({ page }) => {
  const today = todayLocalISO();
  // A FRESH user per run → a fresh space → an EMPTY today-day. So this always exercises the clean
  // from-nothing path (the shared dev DB is never truncated; a fixed email would accumulate state).
  const email = `journal-edit-${Date.now()}@mathmeander.local`;
  const p1 = 'First paragraph.';
  const p2 = 'Second paragraph.';

  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();

  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();

  // Type two paragraphs into the (empty) ProseMirror editor, then wait for the debounced autosave's
  // PUT to land (robust to the transient "Saving…" indicator — a missing save fails this loudly).
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type(p1);
  await page.keyboard.press('Enter');
  await page.keyboard.type(p2);

  await page.waitForResponse(
    (r) => r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 15000 }, // generous headroom for the debounce + a cold dev server's first PUT
  );

  // Reload: the prose persisted (the from-nothing authoring path, observed end-to-end).
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText(p1);
  await expect(page.locator('.ProseMirror')).toContainText(p2);
});
