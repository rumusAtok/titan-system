// Test H - Interface testing, in a real browser against the real stack.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { GATEWAY, login, navLinks, recordApiCalls, unique } from './helpers';

test.describe('role-based navigation', () => {
  test('an applicant sees only their own area and is taken straight to it', async ({ page }) => {
    await login(page, 'alice.applicant');
    await expect(page).toHaveURL(/\/government\/$/);
    await expect(navLinks(page)).toHaveText(['Applications']);
    await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
    await expect(page.getByTestId('user-roles')).toHaveText('Applicant');
  });

  test('a validation officer sees operational screens and the review inbox, not administration', async ({ page }) => {
    await login(page, 'victor.validator');
    await expect(navLinks(page)).toHaveText(['Executive dashboard', 'Applications', 'Review inbox', 'IoT operations', 'GIS operations', 'AI workspace']);
  });

  test('a tenant administrator additionally sees administration and disaster recovery', async ({ page }) => {
    await login(page, 'adam.admin');
    const labels = await navLinks(page).allTextContents();
    expect(labels).toContain('Administration');
    expect(labels).toContain('Disaster recovery');
    await expect(page.getByTestId('tenant-name')).toHaveText('Riverbend City Council');
  });

  test('a platform DR operator lands on the disaster-recovery dashboard', async ({ page }) => {
    await login(page, 'pat.platform');
    await expect(page).toHaveURL(/\/dr\/$/);
    await expect(navLinks(page)).toHaveText(['Disaster recovery']);
    await expect(page.getByTestId('recovery-controls')).toBeVisible();
  });

  test('the same screen shows each tenant its own data', async ({ browser }) => {
    const a = await browser.newPage();
    await login(a, 'adam.admin');
    const b = await (await browser.newContext()).newPage();
    await login(b, 'brian.admin');
    await expect(a.getByTestId('tenant-name')).toHaveText('Riverbend City Council');
    await expect(b.getByTestId('tenant-name')).toHaveText('Northfield District Authority');
    await a.goto('/iot/');
    await b.goto('/iot/');
    await expect(a.getByText('RB-WL-001').first()).toBeVisible();
    await expect(b.getByText('NF-WL-001').first()).toBeVisible();
    await expect(b.getByText('RB-WL-001')).toHaveCount(0);
  });
});

test.describe('pages are fed by the real API', () => {
  test('the executive dashboard shows the figures the analytics API returns', async ({ page }) => {
    const calls = recordApiCalls(page);
    const summaryResponse = page.waitForResponse((r) => r.url() === `${GATEWAY}/api/analytics/kpis/summary` && r.status() === 200);
    await login(page, 'anna.analyst');
    const summary = await (await summaryResponse).json();

    const cards = page.getByTestId('kpi-cards');
    await expect(cards).toBeVisible();
    // The numbers on screen are the numbers in the API response.
    await expect(cards.getByText('Approvals completed').locator('xpath=following-sibling::dd').locator('[data-stat-value]')).toHaveText(summary.approvals.completed.toLocaleString('en-US'));
    await expect(cards).toContainText(`${summary.approvals.approved} approved · ${summary.approvals.rejected} rejected`);
    await expect(cards).toContainText(`${summary.sensors.online} of ${summary.sensors.devices} sensors online`);
    await expect(page.getByRole('img', { name: /water level per sensor/i })).toBeVisible();
    await expect(page.getByRole('img', { name: /incidents by severity/i })).toBeVisible();
    await expect(page.getByText('Simulated data').first()).toBeVisible();

    const services = new Set(calls.filter((c) => c.status === 200).map((c) => c.url.split('/api/')[1]!.split('/')[0]));
    for (const expected of ['analytics', 'incident', 'workflow', 'asset', 'tenant', 'notification']) expect(services, `called ${expected}`).toContain(expected);
    expect(calls.filter((c) => c.status >= 500)).toEqual([]);
  });

  test('IoT operations shows live sensor data and receives events over the live stream', async ({ page }) => {
    await login(page, 'derek.duty', '/iot/');
    await expect(page.getByTestId('sensor-tiles')).toBeVisible();
    await expect(page.getByTestId('sensor-tiles').getByText('Old Bridge level sensor')).toBeVisible();
    await expect(page.getByTestId('stream-status')).toContainText('Live');
    // The simulator publishes every few seconds: readings arrive without reloading the page.
    await expect(page.getByText(/[1-9]\d* live readings? received/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('img', { name: /Live line chart of water level/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Alarm history' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Incidents' })).toBeVisible();
  });

  test('GIS operations lists the mapped records and shows location detail', async ({ page }) => {
    await login(page, 'amy.assets', '/gis/');
    const list = page.getByRole('list', { name: 'Records shown on the map' });
    await expect(list.getByRole('button', { name: /North Bank pump station/ })).toBeVisible();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await list.getByRole('button', { name: /North Bank pump station/ }).click();
    const detail = page.getByTestId('location-detail');
    await expect(detail).toContainText('RB-PS-01');
    await expect(detail).toContainText('Pump station');
    // Filtering: hide assets, the asset disappears from the list.
    await page.getByRole('checkbox', { name: 'Assets', exact: true }).uncheck();
    await expect(list.getByRole('button', { name: /North Bank pump station/ })).toHaveCount(0);
    await expect(list.getByRole('button', { name: /^Upper river level sensor/ })).toBeVisible();
  });

  test('administration shows organisation, workflow configuration and audit records', async ({ page }) => {
    await login(page, 'adam.admin', '/admin/');
    await expect(page.getByRole('table', { name: 'Departments' })).toContainText('ENGINEERING');
    await page.getByRole('tab', { name: 'Roles and members' }).click();
    await expect(page.getByText('Final approver').first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Memberships' })).toContainText('victor.validator');
    await page.getByRole('tab', { name: 'Workflows' }).click();
    await expect(page.getByRole('heading', { name: 'Building permit approval' })).toBeVisible();
    await expect(page.getByText('Department endorsement')).toBeVisible();
    await page.getByRole('tab', { name: 'Audit records' }).click();
    await expect(page.getByRole('table', { name: 'Audit records' }).getByRole('row').nth(1)).toBeVisible();
  });

  test('the AI workspace states model availability and labels how an answer was produced', async ({ page }) => {
    test.setTimeout(260_000);
    const statusResponse = page.waitForResponse((r) => r.url() === `${GATEWAY}/api/ai/status` && r.status() === 200);
    await login(page, 'derek.duty', '/ai/');
    const status = await (await statusResponse).json();
    const indicator = page.getByTestId('ai-availability');
    await expect(indicator).toHaveAttribute('data-mode', status.mode);
    await expect(indicator).toContainText(status.mode === 'model' ? 'Model available' : 'No model available');

    await page.getByLabel('Your question').fill('What is the current river level?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.getByTestId('ai-answer').last();
    // A CPU-only local model may need to be loaded first.
    await expect(answer).toBeVisible({ timeout: 200_000 });
    await expect(answer).toHaveAttribute('data-status', 'ok');
    const kind = await answer.getAttribute('data-generated-by');
    await expect(answer).toContainText(kind === 'model' ? 'AI-generated' : 'not AI-generated');
    if (status.mode !== 'model') expect(kind).toBe('deterministic');
    await expect(answer.getByText('Sources')).toBeVisible();
    await expect(answer).toContainText('Latest water-level readings');
  });

  test('the disaster-recovery dashboard shows real service health and labels the lab topology', async ({ page }) => {
    const healthResponse = page.waitForResponse((r) => r.url() === `${GATEWAY}/api/platform/health` && r.status() === 200);
    await login(page, 'adam.admin', '/dr/');
    const health = await (await healthResponse).json();
    await expect(page.getByRole('note')).toContainText('not geographic disaster recovery');
    const table = page.getByTestId('service-health');
    await expect(table.getByRole('row')).toHaveCount(health.services.length + 1);
    await expect(table.getByRole('row', { name: /workflow-service/ })).toContainText('Ok');
    await expect(page.getByText('Primary database').locator('xpath=following-sibling::dd').locator('[data-stat-value]')).toHaveText('Primary');
    // A tenant administrator can look, but recovery controls are for DR operators.
    await expect(page.getByTestId('recovery-controls-locked')).toBeVisible();
    await expect(page.getByTestId('recovery-controls')).toHaveCount(0);
  });
});

test.describe('government workspace', () => {
  test('an application is submitted in the browser, decided by a reviewer, and the applicant sees the progress', async ({ browser }) => {
    const title = unique('Garden office');
    const applicant = await browser.newPage();
    await login(applicant, 'alice.applicant', '/government/new/');
    await applicant.getByRole('combobox', { name: 'Form' }).selectOption('building-permit');
    await applicant.getByLabel('Title').fill(title);
    await applicant.getByLabel('Applicant name').fill('Alice Applicant');
    await applicant.getByLabel('Site address').fill('7 Browser Test Road, Riverbend');
    await applicant.getByLabel('Project type').selectOption('residential');
    await applicant.getByLabel('Floor area (m²)').fill('24');
    await applicant.getByLabel(/I declare the information given is correct/).check();
    await applicant.getByRole('button', { name: 'Submit application' }).click();

    await expect(applicant).toHaveURL(/\/government\/case\/\?id=/);
    await expect(applicant.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(applicant.getByText('In review').first()).toBeVisible({ timeout: 20_000 });
    await expect(applicant.getByRole('listitem').filter({ hasText: 'Validation' }).first()).toHaveAttribute('aria-current', 'step');
    // The applicant has no decision controls.
    await expect(applicant.getByRole('button', { name: 'Record decision' })).toHaveCount(0);

    const reviewer = await (await browser.newContext()).newPage();
    await login(reviewer, 'victor.validator', '/government/inbox/');
    await reviewer.getByLabel('Filter Pending workflow tasks').fill(title);
    const row = reviewer.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Decide' }).click();
    const dialog = reviewer.getByRole('dialog');
    // Rejecting or returning needs a comment: those buttons stay disabled until one is given.
    await expect(dialog.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await dialog.getByLabel('Comment').fill('Checked in the browser test');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(reviewer.getByRole('row').filter({ hasText: title })).toHaveCount(0);

    // Back on the applicant's screen: the next stage is current and the decision is in the history.
    await expect(applicant.getByRole('listitem').filter({ hasText: 'Technical review' }).first()).toHaveAttribute('aria-current', 'step', { timeout: 25_000 });
    await expect(applicant.getByRole('table', { name: 'Decisions' })).toContainText('victor.validator');
    await expect(applicant.getByRole('table', { name: 'Decisions' })).toContainText('Checked in the browser test');
  });

  test('the application list can be filtered, sorted and its columns configured', async ({ page }) => {
    await login(page, 'victor.validator', '/government/');
    const table = page.getByRole('table', { name: 'Applications' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Decided' })).toHaveCount(0);
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('group', { name: 'Visible columns' }).getByLabel('Decided').check();
    await expect(table.getByRole('columnheader', { name: 'Decided' })).toBeVisible();

    await table.getByRole('button', { name: 'Reference' }).click();
    await expect(table.getByRole('columnheader', { name: 'Reference' })).toHaveAttribute('aria-sort', 'ascending');

    await page.locator('#status-filter').selectOption('approved');
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    for (const text of await table.getByRole('row').locator('td:nth-child(4)').allTextContents()) expect(text).toBe('Approved');
  });
});

test.describe('error, empty, unauthorised and degraded states', () => {
  test('the server-side validation message is shown when a form is rejected', async ({ page }) => {
    await login(page, 'alice.applicant', '/government/new/');
    await page.getByRole('combobox', { name: 'Form' }).selectOption('building-permit');
    await page.getByLabel('Title').fill(unique('Incomplete'));
    await page.getByLabel('Applicant name').fill('Alice Applicant');
    await page.getByLabel('Site address').fill('1 Incomplete Way');
    await page.getByLabel('Project type').selectOption('commercial');
    // Bypass the browser's own range check to prove the server validates too.
    await page.getByLabel('Floor area (m²)').evaluate((el: HTMLInputElement) => { el.removeAttribute('min'); el.removeAttribute('max'); });
    await page.getByLabel('Floor area (m²)').fill('99999999');
    await page.getByLabel(/I declare/).check();
    await page.getByRole('button', { name: 'Submit application' }).click();
    const alert = page.getByRole('alert').first();
    await expect(alert).toContainText('form data is invalid');
    await expect(alert).toContainText('must be at most 1000000');
  });

  test('a screen the role may not use shows an unauthorised state instead of data', async ({ page }) => {
    await login(page, 'victor.validator', '/admin/');
    await page.getByRole('tab', { name: 'Audit records' }).click();
    await expect(page.locator('[data-state="unauthorized"]')).toContainText('Not authorised');
    await expect(page.getByRole('table', { name: 'Audit records' })).toHaveCount(0);
  });

  test('an empty result is explained (applicant with a filter that matches nothing)', async ({ page }) => {
    await login(page, 'alice.applicant', '/government/');
    await page.getByLabel('Filter Applications').fill('zzzz-no-such-application');
    await expect(page.getByText('No records match the filter')).toBeVisible();
    await expect(page.getByText(/^0 of \d+ records?$/)).toBeVisible();
  });

  test('when a service is unavailable its panel says so and the rest of the page keeps working (fault injected in the browser)', async ({ page }) => {
    // Injected fault: the incident service answers 503. This exercises the UI's
    // degraded state; real service outages are covered by Test G.
    await page.route(`${GATEWAY}/api/incident/**`, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { status: 503, code: 'upstream_unavailable', message: 'incident-service is temporarily unavailable' } }) }),
    );
    await login(page, 'anna.analyst');
    const degraded = page.locator('[data-state="degraded"]');
    await expect(degraded.first()).toContainText('Service unavailable');
    await expect(degraded.first().getByRole('button', { name: 'Retry' })).toBeVisible();
    // Other panels, fed by other services, still render.
    await expect(page.getByTestId('kpi-cards')).toBeVisible();
    await expect(page.getByRole('img', { name: /assets by lifecycle status/i })).toBeVisible();
  });

  test('an unknown address returns a 404 page', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist/');
    expect(response?.status()).toBe(404);
  });
});

test.describe('responsive layout and accessibility', () => {
  test('on a phone the navigation collapses into a menu and pages do not overflow sideways', async ({ browser }) => {
    test.setTimeout(150_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await login(page, 'adam.admin');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.locator('aside').first()).toBeHidden();

    for (const path of ['/', '/government/', '/iot/', '/gis/', '/admin/', '/dr/']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#mobile-menu').getByRole('link', { name: 'IoT operations' }).click();
    await expect(page).toHaveURL(/\/iot\/$/);
    await expect(page.locator('#mobile-menu')).toHaveCount(0);
    await context.close();
  });

  test('every main page has one heading, landmarks, and no serious accessibility violations', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, 'adam.admin');
    const findings: string[] = [];
    for (const path of ['/', '/government/', '/government/new/', '/government/inbox/', '/iot/', '/gis/', '/ai/', '/admin/', '/dr/']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached();
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('.maplibregl-map').analyze();
      for (const v of results.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) {
        findings.push(`${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
      }
    }
    expect(findings, 'critical or serious WCAG 2 A/AA violations').toEqual([]);
  });

  test('the application can be operated from the keyboard', async ({ page }) => {
    await login(page, 'victor.validator');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });
});
