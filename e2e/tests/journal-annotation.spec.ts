// §6.2 brace annotations — the FOUNDATION suite, run in a real browser (jsdom has no geometry). These tests
// deliberately reproduce the REAL scenarios that previous rounds shipped broken (multi-expression typed
// blocks, interior lines, display math), pinning the three design principles:
//   P1 outer-hull rule: a denominator offers Under only — a brace never creates intra-expression space.
//   P2 outer-band reservation: an interior line of a multi-line typed block GROWS for its brace band; no
//      brace/label ever overlaps a text line.
//   P3 decoration-only + toggle: ⌥⌘A hides every artifact and the layout returns to PRISTINE.
// Precision: a sub-term brace must sit over the RIGHT expression (`data-expr-id`-scoped), even when several
// `$…$` exprs share one block — the exact bug the user hit.
// The annotation POST is debounced: PRE-REGISTER every waitForResponse before its triggering action.
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

const annoPost = (r: {
  url(): string;
  request(): { method(): string };
  status(): number;
}): boolean =>
  r.url().includes('/annotations') && r.request().method() === 'POST' && r.status() === 200;

const brace = (page: import('@playwright/test').Page) =>
  page.locator('.mm-anno-overlay svg.anno-brace path.anno-brace-path');
const noError = (page: import('@playwright/test').Page) =>
  expect(page.getByText(/Couldn.t save/i)).toHaveCount(0);

type Box = { x: number; y: number; width: number; height: number };
/** One caption row (LABEL_HEIGHT + spacing in the web package) — the collision pass's vertical step. */
const LABEL_STEP = 20;
const overlapsV = (a: Box, b: Box): boolean => a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const overlapsH = (a: Box, b: Box): boolean => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1;

/** The exact on-screen rect of a TEXT substring inside the editor, via an in-page Range — `getByText`
 *  matches enclosing ELEMENTS (for soft-break lines that's the whole block), so precise word geometry must
 *  come from the text node itself. Returns null when absent or hidden (zero width). */
const wordRectOf = (page: import('@playwright/test').Page, word: string, root = '.ProseMirror') =>
  page.evaluate(
    ([w, rootSel]) => {
      type TextNode = { nodeValue: string | null };
      type Doc = {
        querySelector(s: string): unknown;
        createTreeWalker(root: unknown, what: number): { nextNode(): TextNode | null };
        createRange(): {
          setStart(n: TextNode, o: number): void;
          setEnd(n: TextNode, o: number): void;
          getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        };
      };
      const doc = (globalThis as unknown as { document: Doc }).document;
      const walker = doc.createTreeWalker(doc.querySelector(rootSel), 4 /* TEXT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.nodeValue ?? '').indexOf(w);
        if (i < 0) continue;
        const r = doc.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        // width > 1: KaTeX's accessibility MathML is CLIPPED to ~1px (not display:none) and precedes the
        // visual glyphs in DOM order — a 1px "match" there is not the on-screen glyph.
        if (b.width > 1) return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      return null;
    },
    [word, root] as const,
  );

/** A locator's bounding box, polled until present — the overlay rebuilds its children on every transaction,
 *  so a one-shot boundingBox() can race a rebuild and see nothing. */
const boxOf = async (page: import('@playwright/test').Page, selector: string): Promise<Box> => {
  let box: Box | null = null;
  await expect
    .poll(async () => {
      box = await page.locator(selector).first().boundingBox();
      return box != null;
    })
    .toBeTruthy();
  return box!;
};

test('PRECISION: in a multi-expression typed block, the brace lands on the annotated (last) expression', async ({
  page,
}) => {
  await openToday(page, `anno-precision-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The user's exact bug shape: a typed (definition) block, several lines, an inline expr per line.
  await page.keyboard.type('Def. A machine is a triple $t = (Q, S, d)$ where');
  await page.keyboard.press('Enter'); // a soft line INSIDE the typed unit
  await page.keyboard.type('the set $Q$ is finite and');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the map $d : Q * S -> Q$ drives it');

  // All three inline exprs render; annotate a sub-term of the LAST one.
  await expect(page.locator('.day-editor .math-render')).toHaveCount(3);
  const lastExpr = page.locator('.day-editor .math-render').nth(2);
  const sub = lastExpr.locator('[data-path]').first();
  await sub.dblclick();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  // Leave the math so its render returns, then the brace draws.
  await page.getByText('drives', { exact: false }).first().click();
  await expect(page.locator('.day-editor .math-render')).toHaveCount(3);
  await expect(brace(page)).toBeVisible();

  // THE regression lock: the brace's horizontal extent lies within the LAST expression's box — not the first.
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  const lastBox = (await page.locator('.day-editor .math-render').nth(2).boundingBox())!;
  const firstBox = (await page.locator('.day-editor .math-render').nth(0).boundingBox())!;
  expect(braceBox.x).toBeGreaterThanOrEqual(lastBox.x - 2);
  expect(braceBox.x + braceBox.width).toBeLessThanOrEqual(lastBox.x + lastBox.width + 2);
  expect(overlapsV(braceBox, lastBox) || Math.abs(braceBox.y - lastBox.y) < 60).toBeTruthy();
  // And it is NOT over the first expression's line (the shipped bug drew it there).
  expect(overlapsV(braceBox, firstBox)).toBeFalsy();
  await create;
  await noError(page);
});

test('P2 RESERVE: an interior-line brace grows its line; brace + label overlap no text', async ({
  page,
}) => {
  await openToday(page, `anno-reserve-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Def. first line of the definition');
  await page.keyboard.press('Enter');
  await page.keyboard.type('middle line with $x^2 + y$ inside');
  await page.keyboard.press('Enter');
  await page.keyboard.type('last line of the definition');

  const block = page.locator('p[data-unit-id]', { hasText: 'middle line' });
  const beforeH = (await block.boundingBox())!.height;

  // Annotate a sub-term of the MIDDLE line's expression with an overbrace.
  const sub = page.locator('.day-editor .math-render [data-path]').first();
  await sub.dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await page.getByText('inside', { exact: false }).first().click();
  await expect(brace(page)).toBeVisible();

  // The block GREW (the interior line's box gained the brace band — impossible with block padding).
  await expect.poll(async () => (await block.boundingBox())!.height).toBeGreaterThan(beforeH + 8);

  // No overlap once the reserve CONVERGES (the feedback controller takes a few passes): the brace and the
  // caption intersect no text LINE. The lines live inside ONE block (soft breaks), so element boxes are
  // useless — measure each probe word's actual text rect via an in-page Range.
  const wordRect = (word: string) =>
    page.evaluate((w) => {
      // Structural types only — the e2e tsconfig has no DOM lib (same idiom as the other specs' casts).
      type TextNode = { nodeValue: string | null };
      type Doc = {
        querySelector(s: string): unknown;
        createTreeWalker(root: unknown, what: number): { nextNode(): TextNode | null };
        createRange(): {
          setStart(n: TextNode, o: number): void;
          setEnd(n: TextNode, o: number): void;
          getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        };
      };
      const doc = (globalThis as unknown as { document: Doc }).document;
      const walker = doc.createTreeWalker(doc.querySelector('.ProseMirror'), 4 /* TEXT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.nodeValue ?? '').indexOf(w);
        if (i < 0) continue;
        const r = doc.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      return null;
    }, word);
  const worstOverlap = async (): Promise<number> => {
    const braceBox = await page.locator('.mm-anno-overlay svg.anno-brace').boundingBox();
    const labelBox = await page.locator('.mm-anno-overlay .anno-label').boundingBox();
    if (!braceBox || !labelBox) return 9999;
    let worst = 0;
    for (const word of ['first line', 'middle line', 'last line']) {
      const wb = await wordRect(word);
      if (!wb) continue;
      for (const ab of [braceBox, labelBox]) {
        if (overlapsV(ab, wb) && overlapsH(ab, wb)) {
          const v = Math.min(ab.y + ab.height, wb.y + wb.height) - Math.max(ab.y, wb.y);
          worst = Math.max(worst, v);
        }
      }
    }
    return worst;
  };
  await expect.poll(worstOverlap, { timeout: 5000 }).toBeLessThanOrEqual(0);
});

test('P1 HULL RULE: the denominator of a fraction offers Under only', async ({ page }) => {
  await openToday(page, `anno-hull-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $(a+b)/(c+d)$ now');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  // KaTeX renders the fraction with the denominator LOW in the box — click a point in the lower half to
  // precise-select the denominator group.
  const render = page.locator('.day-editor .math-render').first();
  const rb = (await render.boundingBox())!;
  await page.mouse.dblclick(rb.x + rb.width / 2, rb.y + rb.height * 0.8);
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  // The hull rule: no Over for a denominator-side target; Under is offered.
  await expect(page.getByRole('button', { name: '⏟ Under' })).toBeVisible();
  await expect(page.getByRole('button', { name: '⏞ Over' })).toBeHidden();
});

test('DISPLAY: a $$…$$ sub-term annotates with a correctly-placed brace', async ({ page }) => {
  await openToday(page, `anno-display-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$x^2 + y$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();
  const sub = page.locator('.day-editor .math-render-display [data-path="0"]').first();
  await expect(sub).toBeVisible();
  const subBox = (await sub.boundingBox())!;

  await sub.dblclick();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  // Precision: the brace spans the clicked sub-term's box (x^2 sits at the equation's left). Polled — the
  // overlay rebuilds its children on every transaction, so a one-shot boundingBox can race a rebuild.
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(Math.abs(braceBox.x - subBox.x)).toBeLessThan(12);
  await create;
  await noError(page);

  // Persists + re-renders after reload.
  await page.reload();
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();
  await expect(brace(page)).toBeVisible();
});

test('P3 TOGGLE: hiding annotations restores the pristine layout; showing restores braces', async ({
  page,
}) => {
  await openToday(page, `anno-toggle-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('above line');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the discriminant is positive');

  const block = page.locator('p[data-unit-id]', { hasText: 'discriminant' });
  const pristineH = (await block.boundingBox())!.height;

  await page.getByText('discriminant', { exact: false }).first().dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  await expect.poll(async () => (await block.boundingBox())!.height).toBeGreaterThan(pristineH + 8);

  // Toggle OFF via the VISIBLE BUTTON (the real path — a synthetic ⌥⌘A masked the macOS dead-key failure):
  // every artifact vanishes and the layout returns to pristine.
  await page.getByRole('button', { name: 'Annotations: on' }).click();
  await expect(brace(page)).toHaveCount(0);
  await expect(page.locator('.mm-anno-overlay .anno-label')).toHaveCount(0);
  await expect.poll(async () => (await block.boundingBox())!.height).toBeLessThan(pristineH + 3);

  // Toggle back ON: the brace + its space return.
  await page.getByRole('button', { name: 'Annotations: off' }).click();
  await expect(brace(page)).toBeVisible();
  await expect.poll(async () => (await block.boundingBox())!.height).toBeGreaterThan(pristineH + 8);
});

test('PROSE lifecycle: overbrace binds a phrase, persists, reloads; ✕ removes it', async ({
  page,
}) => {
  const today = await openToday(page, `anno-prose-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('the discriminant is positive');
  await page.getByText('discriminant', { exact: false }).first().dblclick();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  await expect(page.locator('.mm-anno-popover')).toBeHidden(); // dismisses after choosing

  // Caption commits on Enter → a second annotation write.
  const labelWrite = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.locator('.mm-anno-overlay .anno-caption').click();
  await page.keyboard.type('key quantity');
  await page.keyboard.press('Enter');
  await labelWrite;
  await create;
  await noError(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(brace(page)).toBeVisible();
  await expect(page.locator('.mm-anno-overlay .anno-caption')).toContainText('key quantity');

  // ✕ removes: brace gone now and after reload (the delete drained).
  const del = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.locator('.mm-anno-overlay .anno-label button[aria-label="remove annotation"]').click();
  await expect(brace(page)).toHaveCount(0);
  await del;
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('the discriminant is positive');
  await expect(brace(page)).toHaveCount(0);
});

// ── Round 4: the residual defects from manual testing, each locked as a scenario ──

test('SNAP-TO-STRUCTURE: a hand-dragged source selection of {L, S, R} binds the SET, not the whole expression', async ({
  page,
}) => {
  await openToday(page, `anno-snap-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('map $d : Q * S -> Q * S * {L, S, R}$ here');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  const exprBox = (await page.locator('.day-editor .math-render').first().boundingBox())!;

  // Reveal the source (dblclick a sub-term → ✎ source — native arrows can't step into display:none text),
  // then DRAG over `{L, S, R}` — a hand selection that previously missed the exact charSpan match and
  // silently widened to the WHOLE expression.
  await page.locator('.day-editor .math-render [data-path]').first().dblclick();
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible(); // source revealed
  const srcRect = await wordRectOf(page, '{L, S, R}');
  expect(srcRect).not.toBeNull();
  const midY = srcRect!.y + srcRect!.height / 2;
  await page.mouse.move(srcRect!.x + 2, midY);
  await page.mouse.down();
  await page.mouse.move(srcRect!.x + srcRect!.width - 2, midY, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  // IMMEDIATE draw: annotating a math target keeps the equation RENDERED (suppress) — no caret dance needed.
  await expect(brace(page)).toBeVisible();
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  // The brace covers the SET (the right-end portion), NOT the whole expression.
  expect(braceBox.width).toBeLessThan(exprBox.width * 0.55);
  expect(braceBox.x).toBeGreaterThan(exprBox.x + exprBox.width * 0.4);
  await create;
  await noError(page);
});

test('SOURCE REVEAL paths: dblclick structurally selects (render stays); ✎ source reveals for editing', async ({
  page,
}) => {
  await openToday(page, `anno-reveal-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $x^2 + y$ ok');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  // First dblclick on a sub-term: STRUCTURAL selection — the render STAYS and the popover offers kinds.
  const sub = page.locator('.day-editor .math-render [data-path="0"]').first();
  await sub.dblclick();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible(); // NOT revealed

  // The ✎ source action reveals the `$…$` source for editing (the guaranteed mouse path in).
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible();
});

test('MIXED word+math span: bounded growth, convergence, and no intersection with the block above', async ({
  page,
}) => {
  await openToday(page, `anno-mixed-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('the block above');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('all elements from $S$ included');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  const aboveBlock = page.locator('p[data-unit-id]', { hasText: 'the block above' });
  const target = page.locator('p[data-unit-id]', { hasText: 'elements' });
  const beforeH = (await target.boundingBox())!.height;

  // Drag from the word "from" across the rendered math — a MIXED prose_span (word + math run).
  const fromBox = (await wordRectOf(page, 'from'))!;
  const mathBox = (await page.locator('.day-editor .math-render').first().boundingBox())!;
  const y = fromBox.y + fromBox.height / 2;
  await page.mouse.move(fromBox.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(mathBox.x + mathBox.width + 4, y, { steps: 5 });
  await page.mouse.up();

  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();

  // BOUNDED growth (the reported runaway ballooned 300px+): roughly one band, then STABLE.
  await expect
    .poll(async () => (await target.boundingBox())!.height, { timeout: 4000 })
    .toBeGreaterThan(beforeH + 8);
  await page.waitForTimeout(600); // let the controller settle
  const settledH = (await target.boundingBox())!.height;
  expect(settledH - beforeH).toBeLessThan(60);
  await page.waitForTimeout(400);
  expect(Math.abs((await target.boundingBox())!.height - settledH)).toBeLessThanOrEqual(2);

  // The brace/label never intersect the block above.
  const aboveBox = (await aboveBlock.boundingBox())!;
  for (const loc of ['.mm-anno-overlay svg.anno-brace', '.mm-anno-overlay .anno-label']) {
    const ab = await boxOf(page, loc);
    expect(overlapsV(ab, aboveBox) && overlapsH(ab, aboveBox)).toBeFalsy();
  }
});

test('DISPLAY (cue-authored, multi-line source): a sub-term annotates from the RENDER', async ({
  page,
}) => {
  await openToday(page, `anno-display2-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The user's real authoring shape: type `$$` ⏎ content ⏎ `$$` — plain Enter is a SOFT line in the
  // paragraph model, so the block's source becomes the MULTI-LINE `$$⏎(a + b)^2⏎$$` whose surface contains
  // `\n` — the shape the old `\n` gate silently blocked from annotation.
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('(a + b)^2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // second blank exits into a NEW paragraph
  await page.keyboard.type('after');
  await expect(page.locator('.day-editor .math-render-display .katex').first()).toBeVisible();

  // Dblclick a rendered sub-term (never touching the source) → the popover appears → Over → a brace.
  const sub = page.locator('.day-editor .math-render-display [data-path="0"]').first();
  await expect(sub).toBeVisible();
  const subBox = (await sub.boundingBox())!;
  await sub.dblclick();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(Math.abs(braceBox.x - subBox.x)).toBeLessThan(12);
  await create;
  await noError(page);
});

// ── Round 5: coexistence/stacking, popover placement, tight boxes, tuples, block-border ──

test('SMALL SUB-TERM: dblclick `b` in $(a+b)^2$ → popover near the target (not the corner) → tight brace', async ({
  page,
}) => {
  await openToday(page, `anno-small-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $(a + b)^2$ ok');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  const exprBox = (await page.locator('.day-editor .math-render').first().boundingBox())!;

  const bEl = page.locator('.day-editor .math-render [data-path="0.0.1"]').first();
  await expect(bEl).toBeVisible();
  const bBox = (await bEl.boundingBox())!;
  await bEl.dblclick();

  // The popover anchors at the TARGET's rendered box — never the (0,0) corner (the coordsAtPos-on-hidden bug).
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const menuBox = (await page.locator('.mm-anno-popover').boundingBox())!;
  expect(menuBox.x).toBeGreaterThan(8);
  expect(menuBox.y).toBeGreaterThan(exprBox.y); // below the expression, not at the page corner
  expect(Math.abs(menuBox.x + menuBox.width / 2 - (bBox.x + bBox.width / 2))).toBeLessThan(150);

  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  // TIGHT box: the brace hugs `b`'s glyph.
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(Math.abs(braceBox.x + braceBox.width / 2 - (bBox.x + bBox.width / 2))).toBeLessThan(6);
  await create;
  await noError(page);
});

test('EXPONENT: the brace centers on the rendered 2 (vlist strut geometry ignored)', async ({
  page,
}) => {
  await openToday(page, `anno-exp-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $(a + b)^2$ ok');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  const expEl = page.locator('.day-editor .math-render [data-path="1"]').first();
  await expect(expEl).toBeVisible();
  await expEl.dblclick();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  // The tight-box target: the `2` glyph itself (the text inside the data-path container).
  const glyph = await page.evaluate(() => {
    type El = { childNodes: ArrayLike<{ nodeType: number }> };
    type Doc = { querySelector(s: string): (El & Element) | null };
    type Element = { getBoundingClientRect(): { x: number; width: number } };
    const doc = (globalThis as unknown as { document: Doc }).document;
    const el = doc.querySelector('.day-editor .math-render [data-path="1"]');
    if (!el) return null;
    const r = (el as unknown as Element).getBoundingClientRect();
    return { x: r.x, width: r.width };
  });
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(Math.abs(braceBox.x + braceBox.width / 2 - (glyph!.x + glyph!.width / 2))).toBeLessThan(8);
});

test('COEXISTENCE + STACKING: a second overlapping annotation keeps the first; braces stack apart', async ({
  page,
}) => {
  await openToday(page, `anno-stack-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $(a + b)^2$ ok');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  // First: overbrace `b`.
  await page.locator('.day-editor .math-render [data-path="0.0.1"]').first().dblclick();
  const c1 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  await c1;

  // Second: overbrace the GROUP `(a+b)` (dblclick its opening paren → the deepest box there is the group).
  const groupEl = page.locator('.day-editor .math-render [data-path="0"]').first();
  await groupEl.dblclick({ position: { x: 3, y: 12 } });
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c2 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();

  // BOTH braces live (the first was NOT dropped), stacked without touching each other.
  await expect(brace(page)).toHaveCount(2);
  await expect(page.locator('.mm-anno-overlay .anno-label')).toHaveCount(2);
  await c2;
  await noError(page);
  const b1 = (await page.locator('.mm-anno-overlay svg.anno-brace').nth(0).boundingBox())!;
  const b2 = (await page.locator('.mm-anno-overlay svg.anno-brace').nth(1).boundingBox())!;
  expect(overlapsV(b1, b2) && overlapsH(b1, b2)).toBeFalsy();
});

test('SAME target + SAME kind: no duplicate — the existing caption gains focus for editing', async ({
  page,
}) => {
  await openToday(page, `anno-samedup-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('see $(a + b)^2$ ok');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  const bEl = page.locator('.day-editor .math-render [data-path="0.0.1"]').first();
  await bEl.dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(page.locator('.mm-anno-overlay .anno-label')).toHaveCount(1);

  // Annotate the SAME sub-term with the SAME kind again → still ONE annotation; the caption is focused.
  await bEl.dblclick();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(page.locator('.mm-anno-overlay .anno-label')).toHaveCount(1);
  const focused = await page.evaluate(() => {
    type Doc = { activeElement: { className?: string } | null };
    const doc = (globalThis as unknown as { document: Doc }).document;
    return doc.activeElement?.className ?? '';
  });
  expect(focused).toContain('anno-caption');
});

test('TUPLE: selecting (Q, S, d) in $tau = (Q, S, d)$ binds the TUPLE, not the whole expression', async ({
  page,
}) => {
  await openToday(page, `anno-tuple-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('def $tau = (Q, S, d)$ here');
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  const exprBox = (await page.locator('.day-editor .math-render').first().boundingBox())!;

  // Reveal the source (dblclick a sub-term → ✎ source), then drag over `(Q, S, d)`.
  await page.locator('.day-editor .math-render [data-path]').first().dblclick();
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible();
  const srcRect = (await wordRectOf(page, '(Q, S, d)'))!;
  const midY = srcRect.y + srcRect.height / 2;
  await page.mouse.move(srcRect.x + 2, midY);
  await page.mouse.down();
  await page.mouse.move(srcRect.x + srcRect.width - 2, midY, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();
  const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  // The brace covers the TUPLE (the right-end portion), NOT the whole expression.
  expect(braceBox.width).toBeLessThan(exprBox.width * 0.75);
  expect(braceBox.x).toBeGreaterThan(exprBox.x + exprBox.width * 0.2);
  await create;
  await noError(page);
});

test('LAST-LINE underbrace stays INSIDE the block (no border crossing)', async ({ page }) => {
  await openToday(page, `anno-border-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('the closing statement here');

  await page.getByText('statement', { exact: false }).first().dblclick();
  await page.getByRole('button', { name: '⏟ Under' }).click();
  await expect(brace(page)).toBeVisible();

  // Converge, then: the label's bbox sits INSIDE the block's bbox (the reserve grew the block; the brace
  // never crosses the block border).
  const block = page.locator('p[data-unit-id]', { hasText: 'closing statement' });
  await expect
    .poll(
      async () => {
        const lb = await page.locator('.mm-anno-overlay .anno-label').boundingBox();
        const bb = await block.boundingBox();
        if (!lb || !bb) return false;
        return lb.y + lb.height <= bb.y + bb.height + 1;
      },
      { timeout: 5000 },
    )
    .toBeTruthy();
});

test('DISPLAY glyph precision: clicking 2 binds 2, clicking b binds b (tight hit-testing)', async ({
  page,
}) => {
  await openToday(page, `anno-dispglyph-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$(a + b)^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();

  // The `b` glyph inside the VISUAL render (KaTeX's clipped MathML also carries text). Dblclick its center.
  const bGlyph = (await wordRectOf(page, 'b', '.day-editor .math-render-display .katex-html'))!;
  await page.mouse.dblclick(bGlyph.x + bGlyph.width / 2, bGlyph.y + bGlyph.height / 2);
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c1 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  const bBrace = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  // Bound to b — a narrow brace centered on the b glyph, NOT (a+b) (the reported mis-binding).
  expect(bBrace.width).toBeLessThan(bGlyph.width * 3);
  expect(Math.abs(bBrace.x + bBrace.width / 2 - (bGlyph.x + bGlyph.width / 2))).toBeLessThan(6);
  await c1;

  // The exponent `2` glyph. Dblclick its exact center → bound to 2, not b (the reported mis-binding).
  const twoGlyph = (await wordRectOf(page, '2', '.day-editor .math-render-display .katex-html'))!;
  await page.mouse.dblclick(twoGlyph.x + twoGlyph.width / 2, twoGlyph.y + twoGlyph.height / 2);
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c2 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(2);
  await c2;
  await noError(page);
  // One of the two braces centers on the 2 glyph.
  const boxes = [
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(0).boundingBox())!,
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(1).boundingBox())!,
  ];
  const twoCenter = twoGlyph.x + twoGlyph.width / 2;
  expect(boxes.some((bx) => Math.abs(bx.x + bx.width / 2 - twoCenter) < 6)).toBeTruthy();
});

test('TYPED-BLOCK border: a last-line underbrace stays inside the typed block (margins never credited)', async ({
  page,
}) => {
  await openToday(page, `anno-typedborder-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // A TYPED block (visible background) followed by another block — the inter-block margin must NOT be
  // credited as band space (the reported label-below-the-border bug).
  await page.keyboard.type('Def. the head moves left or right');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // exit the typed unit
  await page.keyboard.type('the following paragraph');

  await page.getByText('right', { exact: false }).first().dblclick();
  await page.getByRole('button', { name: '⏟ Under' }).click();
  await expect(brace(page)).toBeVisible();

  const block = page.locator('p[data-unit-id]', { hasText: 'head moves' });
  await expect
    .poll(
      async () => {
        const lb = await page.locator('.mm-anno-overlay .anno-label').boundingBox();
        const bb = await block.boundingBox();
        if (!lb || !bb) return false;
        return lb.y + lb.height <= bb.y + bb.height + 1;
      },
      { timeout: 5000 },
    )
    .toBeTruthy();
});

test("EXPRESSION-SPAN: an associative sub-chain (Sigma' times {L, S, R}) annotates precisely and survives reload", async ({
  page,
}) => {
  const today = await openToday(page, `anno-span-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // `times` is LEFT-nested: `(Q × Σ') × {L,S,R}` has NO single AST node for the right sub-chain
  // `Sigma' times {L, S, R}` — yet it is a legitimate mathematical target (associativity). The binding
  // falls back to an `expression_span` char range, resolved to covered structure at render time.
  await page.keyboard.type("map $Q times Sigma' times {L, S, R}$ here");
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();

  // Reveal the source, then drag over the sub-chain.
  await page.locator('.day-editor .math-render [data-path]').first().dblclick();
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible();
  const srcRect = (await wordRectOf(page, "Sigma' times {L, S, R}"))!;
  const midY = srcRect.y + srcRect.height / 2;
  await page.mouse.move(srcRect.x + 2, midY);
  await page.mouse.down();
  await page.mouse.move(srcRect.x + srcRect.width - 2, midY, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const create = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toBeVisible();

  // PRECISION: the brace starts at the Σ glyph (Q excluded) and runs through the set's closing brace —
  // NOT expression-wide (the reported bug widened this selection to the whole expression).
  const check = async (): Promise<void> => {
    const braceBox = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
    const qGlyph = (await wordRectOf(page, 'Q', '.day-editor .math-render .katex-html'))!;
    const sigma = (await wordRectOf(page, 'Σ', '.day-editor .math-render .katex-html'))!;
    const rGlyph = (await wordRectOf(page, 'R', '.day-editor .math-render .katex-html'))!;
    expect(braceBox.x).toBeGreaterThan(qGlyph.x + qGlyph.width - 1); // Q is outside the brace
    expect(Math.abs(braceBox.x - sigma.x)).toBeLessThan(4); // starts at Σ
    expect(braceBox.x + braceBox.width).toBeGreaterThan(rGlyph.x + rGlyph.width); // through the set
  };
  await check();
  await create;
  await noError(page);

  // The wire round-trip: the `expression_span` locator persists and REPROJECTS on reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.day-editor .math-render .katex')).toBeVisible();
  await expect(brace(page)).toBeVisible();
  await check();
});

test('DISPLAY captions: two same-side annotations keep separate, brace-adjacent labels (no "b two" merge)', async ({
  page,
}) => {
  await openToday(page, `anno-displabels-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$(a + b)^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();

  // Overbrace `b` captioned "b", then overbrace the exponent `2` captioned "two" — the user's exact state.
  // Two same-side, level-0 annotations whose captions previously (a) clamped to the SAME height at the top
  // of the reserve padding (the render's border-box band included the reserve) and collided into one
  // garbled "b two ×" row, then (b) once staggered VERTICALLY, built a caption tower that detached each
  // caption from its brace and ballooned the reserve. Side-by-side targets must resolve HORIZONTALLY.
  await page.locator('.day-editor .math-render-display [data-path="0.0.1"]').first().dblclick();
  const c1 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  await page.locator('.mm-anno-overlay .anno-caption').click();
  await page.keyboard.type('b');
  await page.keyboard.press('Enter');
  await c1;
  await page.locator('.day-editor .math-render-display [data-path="1"]').first().dblclick();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c2 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(2);
  await page
    .locator('.mm-anno-overlay .anno-label')
    .filter({ hasText: /^×$/ })
    .locator('.anno-caption')
    .click();
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await c2;
  await noError(page);
  await page.waitForTimeout(800); // let the reserve controller + collision pass settle

  const labels = [
    (await page.locator('.mm-anno-overlay .anno-label').nth(0).boundingBox())!,
    (await page.locator('.mm-anno-overlay .anno-label').nth(1).boundingBox())!,
  ];
  const braces = [
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(0).boundingBox())!,
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(1).boundingBox())!,
  ];
  // The captions never collide with each other, nor with either brace.
  expect(overlapsV(labels[0]!, labels[1]!) && overlapsH(labels[0]!, labels[1]!)).toBeFalsy();
  for (const lb of labels)
    for (const bb of braces) expect(overlapsV(lb, bb) && overlapsH(lb, bb)).toBeFalsy();
  // Each caption sits ADJACENT to a brace (its own): caption bottom within one label step above some brace
  // top — never detached in a floating tower (the reported "current positions" defect).
  for (const lb of labels) {
    const near = braces.some((bb) => {
      const d = bb.y - (lb.y + lb.height);
      return d >= -1 && d < LABEL_STEP;
    });
    expect(near).toBeTruthy();
  }
  // And the reserve stays TIGHT: no vertical stagger means no band growth beyond ~one stacking level.
  const glyphTop = (await wordRectOf(page, 'b', '.day-editor .math-render-display .katex-html'))!.y;
  for (const lb of labels) expect(glyphTop - lb.y).toBeLessThan(60);
});

test('CUE-AUTHORED display precision: a, b, 2 each bind their own glyph (render dblclick AND source drag)', async ({
  page,
}) => {
  await openToday(page, `anno-cueglyph-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The user's real authoring shape: `$$` ⏎ content ⏎ `$$`. The math RUN the gesture sees is then one BARE
  // content row (the fences sit beyond hard_breaks), so `srcStart` must come from run↔surface ALIGNMENT —
  // the old fixed `+2` shifted every char offset two left and bound the PARENT node (clicking `b` braced
  // `(a+b)`, `a` the group; single-line `$$…$$` runs include their fences and masked this).
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('(a + b)^2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('after');
  await expect(page.locator('.day-editor .math-render-display .katex').first()).toBeVisible();

  // Render dblclick on `a` → the brace hugs the `a` glyph, not the group.
  const aGlyph = (await wordRectOf(page, 'a', '.day-editor .math-render-display .katex-html'))!;
  await page.mouse.dblclick(aGlyph.x + aGlyph.width / 2, aGlyph.y + aGlyph.height / 2);
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c1 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  const aBrace = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(aBrace.width).toBeLessThan(aGlyph.width * 3);
  expect(Math.abs(aBrace.x + aBrace.width / 2 - (aGlyph.x + aGlyph.width / 2))).toBeLessThan(6);
  await c1;

  // Source drag on `b` (the user's reported path): reveal via ✎, drag the `b` char → the brace hugs the
  // RENDERED b glyph, never (a+b).
  const aEl = page.locator('.day-editor .math-render-display [data-path="0.0.0"]').first();
  await aEl.dblclick();
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible();
  const bSrc = (await wordRectOf(page, 'b', '.day-editor .math-src'))!;
  const midY = bSrc.y + bSrc.height / 2;
  await page.mouse.move(bSrc.x, midY);
  await page.mouse.down();
  await page.mouse.move(bSrc.x + bSrc.width, midY, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  const c2 = page.waitForResponse(annoPost, { timeout: 15000 });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(2);
  await c2;
  await noError(page);
  const bGlyph = (await wordRectOf(page, 'b', '.day-editor .math-render-display .katex-html'))!;
  const boxes = [
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(0).boundingBox())!,
    (await page.locator('.mm-anno-overlay svg.anno-brace').nth(1).boundingBox())!,
  ];
  const bCenter = bGlyph.x + bGlyph.width / 2;
  expect(
    boxes.some((bx) => bx.width < bGlyph.width * 3 && Math.abs(bx.x + bx.width / 2 - bCenter) < 6),
  ).toBeTruthy();
});

test('DELETE one of two display annotations: no flicker, the survivor keeps its reserve and brace', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { __annoDebug: unknown[] }).__annoDebug = [];
  });
  await openToday(page, `anno-del-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$(a + b)^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();

  await page.locator('.day-editor .math-render-display [data-path="0.0.1"]').first().dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  await page.locator('.mm-anno-overlay .anno-caption').click();
  await page.keyboard.type('b');
  await page.keyboard.press('Enter');
  await page.locator('.day-editor .math-render-display [data-path="1"]').first().dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(2);
  await page
    .locator('.mm-anno-overlay .anno-label')
    .filter({ hasText: /^×$/ })
    .locator('.anno-caption')
    .click();
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800); // settle

  // Delete "two" via its ✕.
  const del = page.waitForResponse(annoPost, { timeout: 15000 });
  await page
    .locator('.mm-anno-overlay .anno-label')
    .filter({ hasText: 'two' })
    .locator('button[aria-label="remove annotation"]')
    .click();
  await expect(brace(page)).toHaveCount(1);
  await del;
  await noError(page);
  // The removal never REVEALS the source (the unsuppressed removal flashed the `$$…$$` open — the block
  // ballooned and the page bounced: the reported delete flicker).
  await expect(page.locator('.day-editor .math-src')).toBeHidden();

  // The survivor RE-CONVERGES its reserve (it drifted to 0 while the deleted annotation's max held the
  // shared padding) and the layout SETTLES — no residual grow/shrink cycle.
  await page.waitForTimeout(800);
  const block = page.locator('p[data-unit-id]').first();
  const h1 = (await block.boundingBox())!.height;
  await page.waitForTimeout(600);
  const h2 = (await block.boundingBox())!.height;
  expect(Math.abs(h2 - h1)).toBeLessThanOrEqual(1); // stable layout — no residual grow/shrink cycle
  const pad = await page.evaluate(() => {
    type Doc = { querySelector(s: string): { style: { paddingTop: string } } | null };
    const doc = (globalThis as unknown as { document: Doc }).document;
    return doc.querySelector('.day-editor .math-render-display')?.style.paddingTop ?? '';
  });
  expect(parseFloat(pad || '0')).toBeGreaterThan(4); // the survivor's reserve regrew
  // And the surviving brace still hugs the b glyph.
  const bGlyph = (await wordRectOf(page, 'b', '.day-editor .math-render-display .katex-html'))!;
  const sb = await boxOf(page, '.mm-anno-overlay svg.anno-brace');
  expect(Math.abs(sb.x + sb.width / 2 - (bGlyph.x + bGlyph.width / 2))).toBeLessThan(6);
});

/** Poll until the first block's box stops moving — the reserve controller converges over a few frames,
 *  and gesture coordinates (or geometry asserts) taken mid-convergence land on moved content. */
const settleLayout = async (page: import('@playwright/test').Page): Promise<void> => {
  let prev = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(
          await page.locator('.day-editor p[data-unit-id]').first().boundingBox(),
        );
        const same = now === prev;
        prev = now;
        return same;
      },
      { timeout: 6000, intervals: [200] },
    )
    .toBeTruthy();
};

test('TYPED-BLOCK three annotations: every caption visible INSIDE the block, nesting-ordered; ✕ works', async ({
  page,
}) => {
  await openToday(page, `anno-three-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The user's swallowed-caption shape: a typed block, one inline expression, THREE annotations — an
  // overbrace on the tuple, an overbrace on the WHOLE expression, an expression-span underbrace. The
  // tuple's caption used to be hoisted out of the block (collision hysteresis + MathML-polluted line
  // edge) and buried under the neighbouring content: a brace with no caption and no ✕.
  await page.keyboard.type('Def. A TM is a triple $tau = (Q, Sigma, delta)$ where');
  await page.keyboard.press('Enter');
  await page.keyboard.type('including $q_0$ and stuff');
  await expect(page.locator('.day-editor .math-render .katex').first()).toBeVisible();

  const dragAnnotate = async (word: string, kind: string, caption: string): Promise<void> => {
    await page.locator('.day-editor .math-render [data-path]').first().dblclick();
    await page.getByRole('button', { name: '✎ source' }).click();
    await expect(page.locator('.day-editor .math-src').first()).toBeVisible();
    await settleLayout(page);
    const r = (await wordRectOf(page, word, '.day-editor .math-src'))!;
    const midY = r.y + r.height / 2;
    await page.mouse.move(r.x + 1, midY);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width - 1, midY, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.mm-anno-popover')).toBeVisible();
    await page.getByRole('button', { name: kind }).click();
    await page
      .locator('.mm-anno-overlay .anno-label')
      .filter({ hasText: /^×$/ })
      .locator('.anno-caption')
      .first()
      .click();
    await page.keyboard.type(caption);
    await page.keyboard.press('Enter');
  };
  await dragAnnotate('(Q, Sigma, delta)', '⏞ Over', 'tuple cap');
  await dragAnnotate('tau = (Q, Sigma, delta)', '⏞ Over', 'Hello');
  await dragAnnotate('Sigma, delta', '⏟ Under', 'sigma and delta');
  // Leave the math FIRST: while the inline source is revealed there is no render, hence no braces.
  await page.getByText('including').click();
  await expect(brace(page)).toHaveCount(3);
  await settleLayout(page);

  // Every caption VISIBLE and INSIDE the block; pairwise non-overlapping; nesting order (the whole-expr
  // caption sits ABOVE the tuple's — "outer = higher").
  const block = (await page.locator('p[data-unit-id]').first().boundingBox())!;
  const labelBox = async (text: string): Promise<Box> =>
    (await page.locator('.mm-anno-overlay .anno-label', { hasText: text }).boundingBox())!;
  const tuple = await labelBox('tuple cap');
  const hello = await labelBox('Hello');
  const sigma = await labelBox('sigma and delta');
  for (const lb of [tuple, hello, sigma]) {
    expect(lb.width).toBeGreaterThan(10);
    expect(lb.y).toBeGreaterThanOrEqual(block.y - 1); // inside the block, never over the title/chrome
    expect(lb.y + lb.height).toBeLessThanOrEqual(block.y + block.height + 1);
  }
  expect(overlapsV(tuple, hello) && overlapsH(tuple, hello)).toBeFalsy();
  expect(hello.y + hello.height).toBeLessThanOrEqual(tuple.y + 1); // outer above inner

  // ✕ on the tuple's caption removes ONLY it.
  await page
    .locator('.mm-anno-overlay .anno-label', { hasText: 'tuple cap' })
    .locator('button[aria-label="remove annotation"]')
    .click();
  await expect(brace(page)).toHaveCount(2);
  await expect(page.locator('.mm-anno-overlay .anno-label', { hasText: 'Hello' })).toBeVisible();
  await expect(
    page.locator('.mm-anno-overlay .anno-label', { hasText: 'sigma and delta' }),
  ).toBeVisible();
  await noError(page);
});

test('NESTING ROWS: in (a+b)^2 the leaf captions (a, b, two) share the row nearest the equation; (a+b) above', async ({
  page,
}) => {
  await openToday(page, `anno-rows-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$(a + b)^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();

  const annotate = async (
    path: string,
    caption: string,
    pos?: { x: number; y: number },
  ): Promise<void> => {
    await settleLayout(page);
    const el = page.locator(`.day-editor .math-render-display [data-path="${path}"]`).first();
    if (pos) await el.dblclick({ position: pos });
    else await el.dblclick();
    await expect(page.locator('.mm-anno-popover')).toBeVisible();
    await page.getByRole('button', { name: '⏞ Over' }).click();
    await page
      .locator('.mm-anno-overlay .anno-label')
      .filter({ hasText: /^×$/ })
      .locator('.anno-caption')
      .first()
      .click();
    await page.keyboard.type(caption);
    await page.keyboard.press('Enter');
  };
  await annotate('0.0.0', 'a');
  await annotate('0.0.1', 'b');
  await annotate('0', 'a + b', { x: 3, y: 12 }); // the group via its opening paren
  await annotate('1', 'two');
  await expect(brace(page)).toHaveCount(4);
  await settleLayout(page);

  const labelBox = async (caption: string): Promise<Box> => {
    const b = await page.evaluate((cap) => {
      type El = {
        getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        querySelector(s: string): { textContent: string | null } | null;
      };
      type Doc = { querySelectorAll(s: string): ArrayLike<El> };
      const doc = (globalThis as unknown as { document: Doc }).document;
      for (const el of Array.from(doc.querySelectorAll('.mm-anno-overlay .anno-label'))) {
        if (el.querySelector('.anno-caption')?.textContent === cap) {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
      return null;
    }, caption);
    expect(b, `caption "${caption}" visible`).not.toBeNull();
    return b!;
  };
  const la = await labelBox('a');
  const lb = await labelBox('b');
  const ltwo = await labelBox('two');
  const lgroup = await labelBox('a + b');
  // The CONTAINING annotation's caption sits ABOVE every leaf caption ("outer = higher") — the exponent's
  // caption no longer floats above the group's (the reported inversion).
  for (const leaf of [la, lb, ltwo]) {
    expect(lgroup.y + lgroup.height).toBeLessThanOrEqual(leaf.y + 1);
  }
  // Leaf captions share one row (the raised exponent's caption joins a/b's row).
  expect(Math.abs(la.y - lb.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(la.y - ltwo.y)).toBeLessThanOrEqual(2);
  // No pairwise overlaps.
  const all = [la, lb, ltwo, lgroup];
  for (let i = 0; i < all.length; i += 1)
    for (let j = i + 1; j < all.length; j += 1)
      expect(overlapsV(all[i]!, all[j]!) && overlapsH(all[i]!, all[j]!)).toBeFalsy();
  // TIGHT packing (the excess-spacing complaint): the group's caption sits within one label step of its
  // own brace (the widest one).
  const braces = await page.locator('.mm-anno-overlay svg.anno-brace').all();
  let widest: Box | null = null;
  for (const b of braces) {
    const bx = (await b.boundingBox())!;
    if (!widest || bx.width > widest.width) widest = bx;
  }
  expect(widest!.y - (lgroup.y + lgroup.height)).toBeGreaterThanOrEqual(-1);
  expect(widest!.y - (lgroup.y + lgroup.height)).toBeLessThan(LABEL_STEP);
  await noError(page);
});

test('MULTI-LINE block: each line’s captions stay adjacent to THEIR line; no page-tall reserves', async ({
  page,
}) => {
  await openToday(page, `anno-multiline-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The user's screenshot shape: one typed block with several soft lines, an underbrace on a DIFFERENT
  // line each. The block-wide row grouping laid every underbrace caption at ONE row near the block's
  // bottom, and each reserve ballooned to MAX_SPACER bridging the distance — page-tall gaps.
  await page.keyboard.type('Def. A TM is a triple $tau = (Q, Sigma, delta)$ where');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the set $q_0$ is the start state and');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the set $delta$ drives the machine');
  await expect(page.locator('.day-editor .math-render .katex').first()).toBeVisible();
  const block = page.locator('p[data-unit-id]').first();
  const pristineH = (await block.boundingBox())!.height;

  // Underbrace a sub-term on line 1 and line 2 (different lines, same side, same block).
  const annotateUnder = async (renderIdx: number, caption: string): Promise<void> => {
    await settleLayout(page);
    await page
      .locator('.day-editor .math-render')
      .nth(renderIdx)
      .locator('[data-path]')
      .first()
      .dblclick();
    await expect(page.locator('.mm-anno-popover')).toBeVisible();
    await page.getByRole('button', { name: '⏟ Under' }).click();
    await page
      .locator('.mm-anno-overlay .anno-label')
      .filter({ hasText: /^×$/ })
      .locator('.anno-caption')
      .first()
      .click();
    await page.keyboard.type(caption);
    await page.keyboard.press('Enter');
  };
  await annotateUnder(0, 'first line');
  await annotateUnder(1, 'second line');
  await expect(brace(page)).toHaveCount(2);
  await page.getByText('drives').click(); // caret away
  await settleLayout(page);

  // Each caption within ~1.5 label steps BELOW its own brace (same-line adjacency, never another line's
  // row) and the block grew by a bounded amount (≈ one band per annotated line, NEVER MAX_SPACER-scale).
  const pairs: { brace: Box; label: Box }[] = [];
  for (const caption of ['first line', 'second line']) {
    const label = (await page
      .locator('.mm-anno-overlay .anno-label', { hasText: caption })
      .boundingBox())!;
    let nearest: Box | null = null;
    for (const b of await page.locator('.mm-anno-overlay svg.anno-brace').all()) {
      const bb = (await b.boundingBox())!;
      if (!nearest || Math.abs(bb.y - label.y) < Math.abs(nearest.y - label.y)) nearest = bb;
    }
    pairs.push({ brace: nearest!, label });
    const d = label.y - (nearest!.y + nearest!.height);
    expect(d).toBeGreaterThanOrEqual(-1);
    expect(d).toBeLessThan(LABEL_STEP * 1.5);
  }
  // The two captions sit at genuinely different rows (their own lines), not one shared block-bottom row.
  expect(Math.abs(pairs[0]!.label.y - pairs[1]!.label.y)).toBeGreaterThan(LABEL_STEP);
  const grownH = (await block.boundingBox())!.height;
  expect(grownH - pristineH).toBeLessThan(120); // two bands ≈ 70-90px; the ballooned state was 240+
  await noError(page);
});

test("RESPONSIVENESS: drag-selecting in an annotated display equation's revealed source never freezes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { __annoDebug: unknown[] }).__annoDebug = [];
  });
  await openToday(page, `anno-frz-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('$$(a + b)^2$$');
  await expect(page.locator('.day-editor .math-render-display .katex')).toBeVisible();

  // Two stacked annotations (the reported freeze state had multiple), then reveal the source.
  await page.locator('.day-editor .math-render-display [data-path="0.0.1"]').first().dblclick();
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(1);
  await page
    .locator('.day-editor .math-render-display [data-path="0"]')
    .first()
    .dblclick({ position: { x: 3, y: 12 } });
  await page.getByRole('button', { name: '⏞ Over' }).click();
  await expect(brace(page)).toHaveCount(2);
  await page.locator('.day-editor .math-render-display [data-path="0"]').first().dblclick();
  await page.getByRole('button', { name: '✎ source' }).click();
  await expect(page.locator('.day-editor .math-src').first()).toBeVisible();

  // Drag-select the `2` in the revealed source (the reported gesture).
  const rect = (await wordRectOf(page, '2', '.day-editor .math-src'))!;
  const midY = rect.y + rect.height / 2;
  await page.mouse.move(rect.x, midY);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width, midY, { steps: 5 });
  await page.mouse.up();

  // The page stays RESPONSIVE: a bounded-time probe resolves (a frozen main thread would hang it), the
  // popover appears after the drag settles, and the reserve controller's activity is bounded (no runaway
  // dispatch cycle — the rAF coalescing + oscillation damper guarantee this by construction).
  const winner = await Promise.race([
    page
      .evaluate(() => (globalThis as unknown as { __annoDebug: unknown[] }).__annoDebug.length)
      .then((n) => ({ ok: true as const, n })),
    new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 6000)),
  ]);
  expect(winner.ok).toBeTruthy();
  await expect(page.locator('.mm-anno-popover')).toBeVisible();
  // The reveal + drag legitimately re-converge the reserves (the source line changed the bounds). The
  // no-flicker invariant is GEOMETRY QUIESCENCE: once converged, the reserve padding, the block box, and
  // the scroll position stop moving — a limit cycle (the reported page flicker) never stops moving them.
  const geom = () =>
    page.evaluate(() => {
      type Doc = {
        querySelector(s: string): {
          style: { paddingTop: string };
          getBoundingClientRect(): { top: number; height: number };
        } | null;
      };
      const w = globalThis as unknown as { document: Doc; scrollY: number };
      const el = w.document.querySelector('.day-editor .math-render-display');
      const block = w.document.querySelector('.day-editor p[data-unit-id]');
      const b = block?.getBoundingClientRect();
      return `${el?.style.paddingTop ?? ''}|${Math.round((b?.top ?? 0) * 2)}|${Math.round((b?.height ?? 0) * 2)}|${w.scrollY}`;
    });
  let prev = await geom();
  await expect
    .poll(
      async () => {
        const now = await geom();
        const same = now === prev;
        prev = now;
        return same;
      },
      { timeout: 8000, intervals: [300] },
    )
    .toBeTruthy();
  await page.waitForTimeout(900); // sustained: a limit cycle would move the geometry again
  expect(await geom()).toBe(prev);
});
