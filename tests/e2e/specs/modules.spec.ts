// The modules added after v3 in a real browser: documents, zones, procurement and stores,
// reports, integrations and cameras. Real stack, real Keycloak login, no mocks; data is
// the synthetic seed (npm run seed) of tenant Riverbend.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { GATEWAY, login, navLinks, recordApiCalls } from './helpers';

const PAGES = ['/documents/', '/zones/', '/procurement/', '/reports/', '/integrations/', '/video/'];

test.describe('modules added after v3', () => {
  test('the packs put the new areas in the menu, and each page is fed by its own service', async ({ page }) => {
    const calls = recordApiCalls(page);
    await login(page, 'adam.admin');
    await expect(navLinks(page)).toContainText(['Documents', 'Zones and map', 'Cameras', 'Procurement and stores', 'Reports', 'Integrations']);

    await page.goto('/documents/');
    // Search the register (other tests add documents, so it can span pages), then open by reference.
    await page.getByRole('searchbox', { name: 'Search titles and references' }).fill('Old Bridge');
    await page.getByRole('row', { name: /Old Bridge flood gate inspection report/ }).getByRole('button').first().click();
    await expect(page.getByRole('heading', { level: 2, name: /Old Bridge flood gate inspection report/ })).toBeVisible();
    await expect(page.getByText(/^v1 · old-bridge-gate-inspection-q3.txt/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();

    await page.goto('/zones/');
    await expect(page.getByRole('cell', { name: 'RB-FZ-01', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'North Bank flood zone' })).toBeVisible();

    await page.goto('/procurement/');
    await expect(page.getByRole('cell', { name: 'PS-SEAL-KIT', exact: true })).toBeVisible();
    await expect(page.getByText('Requests awaiting approval')).toBeVisible();

    await page.goto('/reports/');
    await expect(page.getByText('Weekly operations summary', { exact: true }).first()).toBeVisible();

    await page.goto('/integrations/');
    await expect(page.getByRole('button', { name: 'Regional weather service alerts' })).toBeVisible();

    await page.goto('/video/');
    await expect(page.getByRole('button', { name: 'RB-CAM-01' })).toBeVisible();

    for (const service of ['document', 'geo', 'procurement', 'report', 'integration', 'video']) {
      expect(calls.some((c) => c.url.startsWith(`${GATEWAY}/api/${service}/`) && c.status === 200), `${service} answered`).toBe(true);
    }
    expect(calls.filter((c) => c.status >= 500)).toEqual([]);
  });

  test('a report is generated from the page and its run is listed', async ({ page }) => {
    await login(page, 'anna.analyst', '/reports/');
    const row = page.getByRole('row', { name: /Weekly operations summary/ });
    const generated = page.waitForResponse((r) => r.url().includes('/api/report/definitions/') && r.url().endsWith('/generate') && r.request().method() === 'POST');
    await row.getByRole('button', { name: 'Generate now' }).click();
    expect((await generated).status()).toBe(201);
    await expect(page.getByRole('button', { name: 'Open printable' }).first()).toBeVisible();
  });

  test('viewing a camera asks for a purpose and is logged', async ({ page }) => {
    await login(page, 'sara.security', '/video/');
    await page.getByRole('button', { name: 'RB-CAM-01' }).click();
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByLabel('Purpose').fill('Check the gate after the storm warning');
    // The seeded camera streams a synthetic test pattern from the local video test server (HLS).
    const playlist = page.waitForResponse((r) => r.url().endsWith('/cam-a/index.m3u8') && r.status() === 200);
    await page.getByRole('button', { name: 'Open stream' }).click();
    await expect(page.getByText('http://localhost:8888/cam-a/index.m3u8')).toBeVisible();
    await expect(page.getByTestId('camera-video')).toBeVisible();
    await playlist; // the browser fetched the live playlist from the video server
    await page.getByRole('button', { name: 'End viewing' }).click();
    await expect(page.getByText('Check the gate after the storm warning').first()).toBeVisible();
  });

  test('a tenant without a module is told so on the page (the service refusal is covered by the integration tests)', async ({ page }) => {
    await login(page, 'brian.admin', '/procurement/');
    await expect(page.getByText('The procurement and stores pack is not active for your organisation')).toBeVisible();
  });

  test('planning, sourcing and the digital twin show the seeded data, and an inspection round can be recorded', async ({ page }) => {
    test.setTimeout(120_000);
    const calls = recordApiCalls(page);
    await login(page, 'maya.admin', '/maintenance/planning/');
    await expect(page.getByRole('heading', { level: 1, name: 'Maintenance planning' })).toBeVisible();
    await expect(page.getByText('PM-CNC1-LUBE')).toBeVisible();
    await expect(page.getByText('INS-HQ-FIRE')).toBeVisible();

    await page.goto('/procurement/sourcing/');
    await expect(page.getByRole('cell', { name: 'Spindle bearings for the 2027 overhaul' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /MAINT/ }).first()).toBeVisible();

    await page.goto('/twin/');
    await expect(page.getByRole('heading', { level: 1, name: 'Digital twin' })).toBeVisible();
    await page.getByRole('list', { name: 'Assets' }).getByRole('button', { name: /^MER-CNC-01/ }).click();
    await expect(page.getByRole('heading', { level: 3, name: 'Live readings' })).toBeVisible();
    await expect(page.getByText(/bearing temperature|spindle load/i).first()).toBeVisible({ timeout: 20_000 });
    expect(calls.filter((c) => c.status >= 500)).toEqual([]);
  });

  test('the new pages have one heading, landmarks and no serious accessibility violations', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, 'adam.admin');
    const findings: string[] = [];
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('.maplibregl-map').analyze();
      for (const v of results.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) findings.push(`${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
    }
    expect(findings, 'critical or serious WCAG 2 A/AA violations').toEqual([]);
  });

  test('the second-round pages have one heading, landmarks and no serious accessibility violations', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, 'maya.admin', '/workspace/');
    const findings: string[] = [];
    for (const path of ['/maintenance/planning/', '/procurement/sourcing/', '/twin/']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('.maplibregl-map').analyze();
      for (const v of results.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) findings.push(`${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
    }
    expect(findings, 'critical or serious WCAG 2 A/AA violations').toEqual([]);
  });
});
