// Slice 2d / structured-math increment 1: EDITABLE-SYNTAX math live preview. INLINE math is literal `$…$` TEXT
// carrying an invisible `mathExpr` mark (so it copy/pastes as text — the decisive win over the old atom); a
// live-preview decoration RENDERS it with KaTeX (`.math-render`) when the caret is outside and shows the RAW
// `$…$` source (`.math-src`) once the selection touches it. DISPLAY math is a whole-line `$$…$$` (line-only):
// it renders CENTERED (`.math-render-display`) and stays ALWAYS visible — clicking it reveals the `$$…$$`
// source ABOVE the render for editing (`.math-src-display`), not a swap. Recognition is NON-DESTRUCTIVE.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const API = 'http://localhost:8787';

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

test('inline $…$ renders with KaTeX once the caret leaves it, and persists across reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-math-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // Type the math as literal text, then keep typing so the caret leaves the `$…$` → it renders.
  await page.keyboard.type('Energy is $E = m c^2$ qed');

  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible(); // rendered by KaTeX
  // real-WASM boundary: the mathmeander source `c^2` was transpiled to LaTeX `c^{2}` (KaTeX MathML annotation).
  await expect(page.locator('.day-editor .katex annotation').first()).toContainText('c^{2}');
  await expect(editor).toContainText('Energy is');
  await expect(editor).toContainText('qed');

  await page.waitForResponse(put200, { timeout: 15000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible(); // re-rendered from canonical surface
  await expect(editor).toContainText('Energy is');
});

test('copy yields literal $…$ text (the decisive win over the old atom)', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openToday(page, `journal-math-copy-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x^2$ end');
  await expect(page.locator('.day-editor .math-render')).toBeVisible(); // rendered (caret past it)

  await page.keyboard.press(`${MOD}+a`); // select all
  await page.keyboard.press(`${MOD}+c`); // copy
  const clip = await page.evaluate(() =>
    (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
  );
  expect(clip).toContain('$x^2$'); // copying a rendered equation yields its source text
});

test('pasting $…$ text renders it as math', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openToday(page, `journal-math-paste-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.evaluate(() =>
    (
      navigator as unknown as { clipboard: { writeText(t: string): Promise<void> } }
    ).clipboard.writeText('see $a + b$ here'),
  );
  await page.keyboard.press(`${MOD}+v`);
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible(); // the pasted source rendered
  await expect(editor).toContainText('see');
});

test('an unclosed $x is colored as math source while the caret is inside it (open-region feedback)', async ({
  page,
}) => {
  await openToday(page, `journal-math-open-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x'); // no closing $ yet — still being typed
  await expect(page.locator('.day-editor .math-src')).toBeVisible(); // the open source is colored
  await expect(page.locator('.day-editor .math-render')).toHaveCount(0); // not rendered yet (incomplete)
});

test('currency stays plain text — $5 and $10 are not math', async ({ page }) => {
  await openToday(page, `journal-math-cur-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('I have $5 and $10 left');
  await expect(page.locator('.day-editor .math-render')).toHaveCount(0); // never rendered as math
  await expect(editor).toContainText('$5 and $10');
});

test('digit-leading math $3x$ renders (the digit guard is on the close, not the open)', async ({
  page,
}) => {
  await openToday(page, `journal-math-digit-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$3x$ ok'); // typing past it leaves the span → renders
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
});

test('non-destructive: typing a digit right after a complete $x^2$ keeps it as math', async ({
  page,
}) => {
  await openToday(page, `journal-math-nondestruct-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x^2$'); // caret now right after the closing $
  await page.keyboard.type('2'); // a trailing digit must NOT revert the equation to literal text
  await expect(page.locator('.day-editor .math-render')).toHaveCount(1); // the equation survived
  await expect(editor).toContainText('2');
});

test('adjacent equations $x$$y$ both render cleanly (no source styling leaks into the 2nd)', async ({
  page,
}) => {
  await openToday(page, `journal-math-adj-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x$$y$ z'); // two ADJACENT equations, then move the caret past both → both render
  await expect(page.locator('.day-editor .math-render')).toHaveCount(2); // both rendered as KaTeX
  // the 2nd equation's KaTeX must NOT be nested inside the 1st's `$…$` source span (the adjacency bug)
  await expect(page.locator('.day-editor .math-src .math-render')).toHaveCount(0);
});

test('Backspace after "$x$ " deletes only the trailing space, keeping the equation', async ({
  page,
}) => {
  await openToday(page, `journal-math-bksp-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x$ '); // $x$ renders; caret sits after the space
  await page.keyboard.press('Backspace'); // must delete ONLY the space, not the whole equation
  await expect(editor).toContainText('$x$'); // equation source still present (revealed, caret adjacent)
  await page.keyboard.type(' done'); // move the caret past it → it re-renders, proving it survived
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  await expect(editor).toContainText('done');
});

test('double-click reveals the source; a single click does not', async ({ page }) => {
  await openToday(page, `journal-math-dbl-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  const render = page.locator('.day-editor .math-render');
  await editor.click();
  await page.keyboard.type('$x^2$ ok');
  await expect(render).toBeVisible(); // rendered

  await render.click(); // single click → stays rendered (caret placed beside it)
  await expect(render).toBeVisible();

  await render.dblclick(); // double click → reveals the raw source
  await expect(page.locator('.day-editor .math-render')).toHaveCount(0);
  await expect(editor).toContainText('$x^2$');
});

// ── Display math ($$…$$, line-only) ──

test('display $$…$$ on its own line renders centered (KaTeX displayMode) and persists across reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-mathd-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$x^2$$'); // a whole-line display equation
  const render = page.locator('.day-editor .math-render-display');
  await expect(render.locator('.katex')).toBeVisible(); // centered KaTeX (displayMode)
  // real-WASM boundary: the mathmeander source `x^2` was transpiled to LaTeX `x^{2}`.
  await expect(render.locator('.katex annotation').first()).toContainText('x^{2}');

  await page.waitForResponse(put200, { timeout: 15000 }); // persisted as a standalone Math unit
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible(); // re-rendered from canonical
});

test('clicking a display equation reveals its $$…$$ source while the render stays visible', async ({
  page,
}) => {
  await openToday(page, `journal-mathd-edit-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$a + b$$');
  await page.waitForResponse(put200, { timeout: 15000 });
  await page.reload();
  const render = page.locator('.day-editor .math-render-display');
  await expect(render.locator('.katex')).toBeVisible();

  await render.click(); // reveal the source ABOVE the render (NOT a swap — the render persists)
  await expect(page.locator('.day-editor .math-src-display')).toBeVisible();
  await expect(editor).toContainText('$$a + b$$');
  await expect(render.locator('.katex')).toBeVisible(); // render still shown while editing the source
});

test('a single $…$ alone on a line stays INLINE, not display (recognition is line-only)', async ({
  page,
}) => {
  await openToday(page, `journal-mathd-lineonly-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x$');
  await page.keyboard.press('Enter'); // leave the span → it renders
  await expect(page.locator('.day-editor .math-render')).toBeVisible(); // inline render
  await expect(page.locator('.day-editor .math-render-display')).toHaveCount(0); // never a display block
});

test('display source spans MULTIPLE lines ($$ ⏎ … ⏎ $$) and renders centered', async ({ page }) => {
  await openToday(page, `journal-mathd-multi-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$'); // open display mode
  await page.keyboard.press('Enter'); // a newline INSIDE the equation (not a new block)
  await page.keyboard.type('a + b');
  await page.keyboard.press('Enter'); // another in-equation newline
  await page.keyboard.type('$$'); // close → the whole multi-line block is one display equation
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();
});

test('Enter after the closing $$ goes to a new line BELOW the equation — the render stays (bug 2)', async ({
  page,
}) => {
  await openToday(page, `journal-mathd-exit-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$x^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();
  await page.keyboard.press('Enter'); // ONE Enter → exit to a new line; the equation must NOT un-render
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();
  await page.keyboard.type('after'); // lands on the new line below the rendered equation
  await expect(editor).toContainText('after');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible(); // still rendered
});

test('unparseable math is preserved, never dropped (§2.2)', async ({ page }) => {
  await openToday(page, `journal-math-bad-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$x ^^$ z'); // unparseable surface, then leave it
  // It still renders a node (showing the original input verbatim with a quiet warning) — input not dropped.
  await expect(page.locator('.day-editor .math-render')).toHaveCount(1);
  await page.locator('.day-editor .math-render').dblclick(); // reveal the source
  await expect(editor).toContainText('x ^^'); // exactly what was typed, preserved
});

// Slice 2-A (the math-row model): a day carrying an `Equations` system is NOT editable (a non-prose
// container), so it falls back to the read-only `MathContentView` — which now renders the system's
// rows with KaTeX instead of swallowing them (they used to fall through to `null`). Seed via the API
// (the editor authoring path is 2-B): author a prose anchor, then `insert-equations` onto it.
test('a day with an Equations system renders its rows read-only (KaTeX), persisting across reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-eqns-${Date.now()}@mathmeander.local`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('A linear system:');
  await page.waitForResponse(put200); // the prose anchor unit is saved

  const token = await page.evaluate(() => localStorage.getItem('mathmeander.session.token'));
  const auth = { authorization: `Bearer ${token}` };
  const day = await (
    await page.request.get(`${API}/api/journal/days/${today}`, { headers: auth })
  ).json();
  const objectId = day.object.id as string;
  const revision = day.object.revision as number;
  const anchorId = day.graph.content
    .flatMap((c: { units: { id: string; content: { kind: string } }[] }) => c.units)
    .find((u: { content: { kind: string } }) => u.content.kind === 'prose').id as string;

  const expr = (s: string) => ({
    id: randomUUID(),
    surface_text: s,
    surface_format: 'mathmeander',
    original_input: s,
    parse_status: 'renderable',
    occurrences: [],
  });
  const res = await page.request.post(`${API}/api/objects/${objectId}/ops/insert-equations`, {
    headers: auth,
    data: {
      expected_revision: revision,
      anchor_unit_id: anchorId,
      container_unit_id: randomUUID(), // overwritten server-side
      rows: [
        {
          unit_id: randomUUID(),
          content: { kind: 'math', expr: expr('2x+y=1') },
          row_relation: 'eq',
        },
        { unit_id: randomUUID(), content: { kind: 'math', expr: expr('x-y=4') } },
      ],
    },
  });
  expect(res.status()).toBe(200);

  await page.reload();
  const eqns = page.locator('.equations');
  await expect(eqns).toBeVisible();
  await expect(eqns.locator('.row')).toHaveCount(2);
  await expect(eqns.locator('.katex').first()).toBeVisible(); // rows rendered by KaTeX
});

test('a $$…$$ with ≥2 non-empty lines is a SYSTEM: renders aligned rows + persists across reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-system-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // Type a two-equation system: $$, then one equation per line, then close $$.
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter'); // a newline INSIDE the equation
  await page.keyboard.type('2x + y = 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x - y = 4');
  await page.keyboard.press('Enter');
  await page.keyboard.type('$$'); // close → ≥2 non-empty lines = a co-equal system

  // Renders as an aligned stack of rows (the 2-A `.equations` layout), each row KaTeX-rendered.
  await expect(page.locator('.day-editor .equations .row')).toHaveCount(2);
  await expect(page.locator('.day-editor .equations .row .katex').first()).toBeVisible();

  // Persisted as an Equations container + 2 Math rows (a coarse save_content delta — no op).
  await page.waitForResponse(put200, { timeout: 15000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.day-editor .equations .row')).toHaveCount(2); // re-rendered from canonical

  // EDIT a now-PERSISTED row: click the render to reveal the source, type into it, and confirm it SAVES.
  // An existing row must keep its (route-stamped) provenance — re-minting it makes save_content 422 on every
  // flush ("Couldn't save"). So a successful PUT here proves the edited-row frozen-facet bug is fixed.
  await page.locator('.day-editor .equations').first().click();
  await page.keyboard.type('z');
  await page.waitForResponse(put200, { timeout: 15000 });
});
