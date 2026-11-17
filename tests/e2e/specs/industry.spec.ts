// TITAN v3 in a real browser: industry workspaces, pack-defined navigation and
// dashboards, the shared work inbox, and the facilities and maintenance flows.
// Real stack, real Keycloak login, no mocks. All data is synthetic.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { GATEWAY, login, navLinks, recordApiCalls, unique } from './helpers';

test.describe('industry workspaces', () => {
  test('a tenant with two industry packs gets their areas and can narrow the workspace to one industry', async ({ page }) => {
    await login(page, 'maya.admin', '/workspace/');
    await expect(navLinks(page)).toContainText(['Workspace', 'Work inbox', 'Assets', 'Incidents', 'Production equipment', 'Facilities', 'Maintenance', 'Administration']);
    const labels = await navLinks(page).allTextContents();
    for (const label of ['Applications', 'IoT operations', 'Executive dashboard']) expect(labels).not.toContain(label);

    const selector = page.getByTestId('workspace-select');
    await expect(selector).toBeVisible();
    await selector.selectOption('facilities');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Facilities management');
    await expect(navLinks(page)).not.toContainText(['Production equipment']);
    await expect(page.getByRole('heading', { level: 2, name: 'Facilities' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Production equipment' })).toHaveCount(0);
    await selector.selectOption('all');
    await expect(navLinks(page)).toContainText(['Production equipment']);
  });

  test('dashboard widgets show the figures of the registered datasets', async ({ page }) => {
    const calls = recordApiCalls(page);
    // The manufacturing widget "Work orders not completed" queries this dataset with exactly these filters.
    const response = page.waitForResponse((r) => {
      if (r.url() !== `${GATEWAY}/api/analytics/datasets/maintenance_work_orders/query` || r.request().method() !== 'POST' || r.status() !== 200) return false;
      const filters = JSON.parse(r.request().postData() ?? '{}').filters ?? {};
      return filters.pack_id === 'manufacturing' && filters.open === true;
    });
    await login(page, 'maya.admin', '/workspace/');
    const body = await (await response).json();
    const widget = page.getByTestId('widget-work-orders-open');
    await expect(widget).toBeVisible();
    if (body.freshness?.computed_at) {
      const expected = body.rows.reduce((sum: number, r: any) => sum + r.work_orders, 0);
      await expect(widget.locator('[data-stat-value]')).toHaveText(expected.toLocaleString('en-US'));
    } else {
      await expect(widget).toContainText('Not computed yet');
    }
    expect(calls.filter((c) => c.status >= 500)).toEqual([]);
    // Datasets of a capability the tenant does not have are never requested.
    expect(calls.some((c) => c.url.includes('/datasets/approval_turnaround/'))).toBe(false);
  });

  test('a government tenant keeps its executive dashboard and does not see the industries it lacks', async ({ page }) => {
    await login(page, 'adam.admin');
    await expect(page).toHaveURL(/localhost:3000\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Executive dashboard' })).toBeVisible();
    await expect(page.getByTestId('workspace-select')).toHaveCount(1);
    await page.goto('/manufacturing/');
    await expect(page.getByText('The manufacturing pack is not active for your organisation')).toBeVisible();
  });

  // Direct API calls to a module the tenant has not activated are refused: proven against the API
  // with real tokens in tests/integration/industry-packs.test.ts ("A module that is not active ...").
});

test.describe('facilities and maintenance in the browser', () => {
  test('occupant request, approval in the work inbox, assignment, and a technician completing the work', async ({ browser }) => {
    test.setTimeout(180_000);
    const title = unique('Broken window latch');
    const occupant = await (await browser.newContext()).newPage();
    await login(occupant, 'rita.requester');
    await expect(occupant).toHaveURL(/\/facilities\/$/);
    await expect(navLinks(occupant)).toHaveText(['Facilities']);
    await occupant.getByRole('button', { name: 'Raise service request' }).click();
    const dialog = occupant.getByRole('dialog');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Location in the building').fill('Level 2, finance office');
    await dialog.getByLabel('Category').selectOption('other');
    await dialog.getByLabel('Estimated cost').fill('120');
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    await expect(dialog).toHaveCount(0);
    const row = occupant.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Submitted');

    const manager = await (await browser.newContext()).newPage();
    await login(manager, 'fred.facilities', '/work/');
    const task = manager.getByRole('row', { name: new RegExp(title) });
    await expect(task).toBeVisible({ timeout: 20_000 });
    await expect(task).toContainText('Service request');
    await task.getByRole('button', { name: 'Decide' }).click();
    const decision = manager.getByRole('dialog');
    await expect(decision.getByRole('button', { name: 'Return for changes' })).toHaveCount(0);
    await decision.getByRole('button', { name: 'Approve' }).click();
    await expect(decision).toHaveCount(0);

    await occupant.reload();
    const approvedRow = occupant.getByRole('row', { name: new RegExp(title) });
    await expect(approvedRow).toContainText(/Approved/, { timeout: 20_000 });
    await expect(approvedRow).toContainText(/WO-\d{4}-\d{6}/);

    // The tenant administrator (a planning role with access to the member list) assigns the work order.
    const admin = await (await browser.newContext()).newPage();
    await login(admin, 'maya.admin', '/maintenance/');
    const order = admin.getByRole('table', { name: 'Work orders' }).getByRole('row', { name: new RegExp(title) });
    await expect(order).toBeVisible({ timeout: 20_000 });
    await order.getByRole('link', { name: /WO-/ }).click();
    await admin.getByLabel('Assign to').selectOption({ label: 'tim.technician (Maintenance technician)' });
    await admin.getByRole('button', { name: 'Assign' }).click();
    await expect(admin.getByText('Assigned to', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText('tim.technician');
    const url = new URL(admin.url());

    // Another technician sees no action; the assigned one starts and completes the work.
    const other = await (await browser.newContext()).newPage();
    await login(other, 'tess.technician', url.pathname + url.search);
    await expect(other.getByText('Only the assigned technician or a planner can start this work.')).toBeVisible();
    await expect(other.getByRole('button', { name: 'Start work' })).toHaveCount(0);

    const tech = await (await browser.newContext()).newPage();
    await login(tech, 'tim.technician', url.pathname + url.search);
    await tech.getByRole('button', { name: 'Start work' }).click();
    await tech.getByLabel('What was done').fill('Replaced the tap washer.');
    await tech.getByLabel('Labour hours').fill('0.5');
    await tech.getByRole('button', { name: 'Complete work order' }).click();
    await expect(tech.getByText('This work order is completed; no further action is possible.')).toBeVisible();
    await expect(tech.getByRole('listitem').filter({ hasText: 'Replaced the tap washer.' })).toBeVisible();

    // The occupant who raised it is told.
    await occupant.getByRole('button', { name: /Notifications/ }).click();
    await expect(occupant.getByRole('dialog').getByText(/is complete/).first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('new areas: layout and accessibility', () => {
  test('the new pages have one heading, landmarks, no serious accessibility violations, and fit a phone', async ({ browser }) => {
    test.setTimeout(240_000);
    const findings: string[] = [];
    const desktop = await (await browser.newContext()).newPage();
    await login(desktop, 'maya.admin', '/workspace/');
    const paths = ['/workspace/', '/work/', '/assets/', '/incidents/', '/maintenance/', '/manufacturing/', '/facilities/', '/admin/'];
    for (const path of paths) {
      await desktop.goto(path);
      await expect(desktop.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(desktop.getByRole('main')).toBeVisible();
      await desktop.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const results = await new AxeBuilder({ page: desktop }).withTags(['wcag2a', 'wcag2aa']).analyze();
      for (const v of results.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) findings.push(`${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
    }
    expect(findings, 'critical or serious WCAG 2 A/AA violations').toEqual([]);

    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    await login(phone, 'maya.admin', '/workspace/');
    for (const path of paths) {
      await phone.goto(path);
      await expect(phone.getByRole('heading', { level: 1 })).toBeVisible();
      await phone.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
  });
});
