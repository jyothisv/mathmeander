// Slice 2c autosave (local-first): edits must survive a fast navigate-away and a reload-before-sync,
// and the save status must be a calm PERSISTENT element (not the old per-cycle flashing indicator).
// Each test uses a fresh unique email → a fresh space → an empty today-day (the dev DB is never
// truncated), so every run exercises the clean from-nothing path with its own IndexedDB.
import { expect, test, type Page } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
}

/** Open today's (empty) journal day; returns the ISO date (also the day-page heading + list link). */
async function openToday(page: Page): Promise<string> {
  const today = todayLocalISO();
  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  return today;
}

const contentPut200 = (r: { url(): string; request(): { method(): string }; status(): number }) =>
  r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200;

test('edits survive a fast navigate-away and are present on the FIRST reopen', async ({ page }) => {
  await login(page, `autosave-fastnav-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);
  const text = 'Fast-nav paragraph.';

  await page.locator('.ProseMirror').click();
  await page.keyboard.type(text);
  // Navigate away immediately — within the debounce window, before the network flush has settled.
  await page.getByRole('link', { name: '← Journal' }).click();
  await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible();

  // Reopen the SAME day; the text must be there on the first reopen (cache-seed and/or draft restore).
  await page.getByRole('link', { name: today }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText(text);
});

test('edits survive a reload before the network flush (local-first restore)', async ({ page }) => {
  await login(page, `autosave-reload-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);
  const text = 'Reload-survives paragraph.';

  await page.locator('.ProseMirror').click();
  await page.keyboard.type(text);
  // Let the ~200ms local draft persist, but reload before the 800ms network flush fires.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText(text); // restored locally (IndexedDB / exit beacon)

  // And it stays put across a second reload (by now also synced to the server).
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText(text);
});

test('shows a calm, persistent save status (no per-cycle flashing indicator)', async ({ page }) => {
  await login(page, `autosave-status-${Date.now()}@mathmeander.local`);
  await openToday(page);

  // ONE persistent status element (the old conditionally-rendered "Saving…" flash is gone); on an
  // untouched day it sits at the settled "Saved".
  const status = page.locator('.save-status');
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText('Saved');

  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Status check.');
  await page.waitForResponse(contentPut200, { timeout: 15000 });

  // Still exactly one persistent element, settled back to "Saved".
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText('Saved');
});
