import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';

let context: BrowserContext, fixture: http.Server, ui: Page, target: Page;
let origin: string, crossOrigin: string, tabId: number;

async function rawApi(route: string, method = 'GET', body?: unknown) {
  return ui.evaluate(async ({ route, method, body }) => chrome.runtime.sendMessage({
    type: 'relay-api', path: route, method, body,
  }), { route, method, body });
}
async function api(route: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await rawApi(route, method, body);
  if (!response?.ok) throw new Error(response?.error || 'No extension runtime response');
  return response.data;
}
async function action(name: string, args: Record<string, unknown> = {}) {
  return api('/api/browser', 'POST', { action: name, args: { tabId, ...args } });
}
async function openFixture(route: string) {
  await target.goto(origin + route);
  const tabs = await api('/api/tabs');
  tabId = tabs.find((tab: any) => tab.url === origin + route).id;
}
const documentPage = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><style>body{margin:0;padding:32px;font:18px system-ui}button,input{font:inherit;padding:8px}iframe{display:block;width:700px;height:330px;margin:50px 70px;border:8px solid #777}</style></head><body>${body}</body></html>`;

test.beforeAll(async () => {
  fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/frame') {
      res.end(documentPage('Cross-origin frame', '<label>Frame field <input aria-label="Frame field"></label><button onclick="document.querySelector(\'#frame-result\').textContent=\'Frame clicked\'">Frame button</button><p id="frame-result">Waiting</p>'));
    } else if (req.url === '/frames') {
      res.end(documentPage('Frame host', `<h1>Frame host</h1><iframe title="Cross-origin frame" src="${crossOrigin}/frame"></iframe>`));
    } else if (req.url === '/long') {
      res.end(documentPage('Long document', '<h1>Long document</h1>' + Array.from({ length: 110 }, (_, i) => `<button onclick="document.body.dataset.clicked='${i}'">Action ${i}</button>`).join('') + '<p>' + 'Readable document content. '.repeat(1200) + '</p>'));
    } else if (req.url === '/scroll') {
      res.end(documentPage('Scrolled screenshot', '<style>body{padding:0}</style><div style="height:1000px;background:rgb(200,0,0)">Top section</div><div style="height:1400px;background:rgb(0,200,0)"><button id="scrolled-coordinate" style="margin:20px" onclick="this.textContent=\'Scrolled click verified\'">Scrolled target</button></div>'));
    } else if (req.url === '/pointer') {
      res.end(documentPage('Pointer controls', `<button id="hover" onmouseenter="document.querySelector('#hover-result').textContent='Hover revealed'">Hover target</button><p id="hover-result">Not hovered</p><div id="slider" style="position:relative;width:480px;height:60px;background:#ddd;touch-action:none" onpointerdown="this.setPointerCapture(event.pointerId);this.dataset.dragging='yes'" onpointermove="if(this.dataset.dragging==='yes')document.querySelector('#drag-result').textContent='Dragged '+Math.round(event.offsetX)" onpointerup="this.dataset.dragging='no'"></div><p id="drag-result">Not dragged</p><button onclick="alert('Relay modal fixture');document.querySelector('#dialog-result').textContent='Dialog handled'">Open dialog</button><p id="dialog-result">No dialog</p>`));
    } else {
      res.end(documentPage(req.url === '/second' ? 'Second page' : 'First page', `<h1>${req.url === '/second' ? 'Second page' : 'First page'}</h1><button id="coordinate" onclick="document.body.dataset.coordinate='clicked'">Coordinate target</button><a href="/second">Next page</a>`));
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, resolve));
  const port = (fixture.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  crossOrigin = `http://localhost:${port}`;
  const extension = path.resolve('extension');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--site-per-process'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/index.html?view=tab`);
  await expect.poll(async () => (await api('/api/health')).runtime).toBe('chrome-extension');
});

test.beforeEach(async () => { target = await context.newPage(); });
test.afterEach(async () => { await target?.close(); });
test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(resolve => fixture?.close(() => resolve()));
});

test('cross-origin iframe snapshots route refs and native input into the correct frame', async () => {
  await openFixture('/frames');
  await expect(target.frameLocator('iframe').getByRole('button', { name: 'Frame button' })).toBeVisible();
  const root = await action('browser_snapshot');
  const frameId = root.frames.find((frame: any) => frame.url === crossOrigin + '/frame')?.id;
  expect(frameId).toBeTruthy();
  let frame = await action('browser_snapshot', { frameId });
  await action('browser_type', { frameId, ref: frame.elements.find((el: any) => el.name === 'Frame field').ref, text: 'Cross-origin verified', clear: true });
  await expect(target.frameLocator('iframe').getByLabel('Frame field')).toHaveValue('Cross-origin verified');
  frame = await action('browser_snapshot', { frameId });
  await action('browser_click', { frameId, ref: frame.elements.find((el: any) => el.name === 'Frame button').ref });
  await expect(target.frameLocator('iframe').locator('#frame-result')).toHaveText('Frame clicked');
});

test('snapshot pagination reports complete totals and invalidates previous frame references', async () => {
  await openFixture('/long');
  const first = await action('browser_snapshot', { textLimit: 1000, elementLimit: 20 });
  expect(first.text.length).toBe(1000);
  expect(first.textLength).toBeGreaterThan(20000);
  expect(first.hasMoreText).toBe(true);
  expect(first.totalElements).toBe(110);
  expect(first.elements).toHaveLength(20);
  expect(first.hasMoreElements).toBe(true);
  const next = await action('browser_snapshot', { textOffset: 1000, textLimit: 1000, elementOffset: 20, elementLimit: 20 });
  expect(next.textOffset).toBe(1000);
  expect(next.elementOffset).toBe(20);
  expect(next.elements[0].name).toBe('Action 20');
  expect(next.text).not.toBe(first.text);
  const stale = await rawApi('/api/browser', 'POST', { action: 'browser_click', args: { tabId, ref: first.elements[0].ref } });
  expect(stale.ok).toBe(false);
  expect(stale.error).toMatch(/stale|another frame/i);
  await action('browser_click', { ref: next.elements[0].ref });
  await expect(target.locator('body')).toHaveAttribute('data-clicked', '20');
  const last = await action('browser_snapshot', { elementOffset: 100, elementLimit: 20, textOffset: first.textLength, textLimit: 100 });
  expect(last.elements).toHaveLength(10);
  expect(last.hasMoreElements).toBe(false);
  expect(last.text).toBe('');
  expect(last.hasMoreText).toBe(false);
});

test('native hover and pointer drag update the page and JavaScript dialogs recover', async () => {
  await openFixture('/pointer');
  let snapshot = await action('browser_snapshot');
  await action('browser_hover', { ref: snapshot.elements.find((el: any) => el.name === 'Hover target').ref });
  await expect(target.locator('#hover-result')).toHaveText('Hover revealed');
  const box = await target.locator('#slider').boundingBox();
  expect(box).toBeTruthy();
  await action('browser_drag', { fromX: box!.x + 10, fromY: box!.y + 30, toX: box!.x + 400, toY: box!.y + 30, steps: 8 });
  await expect(target.locator('#drag-result')).toHaveText(/Dragged (3\d\d|400)/);
  snapshot = await action('browser_snapshot');
  // Playwright otherwise automatically dismisses dialogs before Relay can
  // handle them. Observe without accepting/dismissing; the extension owns it.
  target.on('dialog', () => {});
  const opened = await rawApi('/api/browser', 'POST', { action: 'browser_click', args: { tabId, ref: snapshot.elements.find((el: any) => el.name === 'Open dialog').ref } });
  expect(opened.ok).toBe(false);
  expect(opened.error).toContain('browser_dialog');
  await action('browser_dialog', { accept: true });
  await expect(target.locator('#dialog-result')).toHaveText('Dialog handled');
  expect((await action('browser_snapshot')).text).toContain('Dialog handled');
});

test('navigation/history, CSS coordinate clicks, and screenshot dimensions agree', async () => {
  await openFixture('/first');
  const navigated = await action('browser_navigate', { url: origin + '/second' });
  expect(navigated.tabId).toBe(tabId);
  expect(navigated.title).toBe('Second page');
  expect((await action('browser_history', { direction: 'back' })).title).toBe('First page');
  expect((await action('browser_history', { direction: 'forward' })).title).toBe('Second page');
  expect((await action('browser_history', { direction: 'reload' })).title).toBe('Second page');
  const box = await target.locator('#coordinate').boundingBox();
  await action('browser_click', { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  await expect(target.locator('body')).toHaveAttribute('data-coordinate', 'clicked');
  const screenshot = await action('browser_screenshot');
  expect(screenshot.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(screenshot.viewport).toMatchObject({ width: 1280, height: 900, coordinateSpace: 'CSS pixels' });
  expect(screenshot.imageSize.width).toBe(Math.round(screenshot.viewport.width * screenshot.viewport.devicePixelRatio));
  expect(screenshot.imageSize.height).toBe(Math.round(screenshot.viewport.height * screenshot.viewport.devicePixelRatio));
  const actualImage = await ui.evaluate(async (dataUrl: string) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const size = { width: image.width, height: image.height }; image.close(); return size;
  }, screenshot.dataUrl);
  expect(actualImage).toEqual(screenshot.imageSize);
  const emulation = await context.newCDPSession(target);
  await emulation.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 2, mobile: false });
  try {
    const scaled = await action('browser_screenshot');
    expect(scaled.viewport).toMatchObject({ width: 900, height: 650, devicePixelRatio: 2 });
    const scaledImage = await ui.evaluate(async (dataUrl: string) => {
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const size = { width: image.width, height: image.height }; image.close(); return size;
    }, scaled.dataUrl);
    expect(scaledImage).toEqual(scaled.imageSize);
    expect(scaled.captureBounds).toMatchObject({ x: 0, y: 0, width: 900, height: 650 });
    const scaledBox = await target.locator('#coordinate').boundingBox();
    const imageX = (scaledBox!.x + scaledBox!.width / 2) * scaled.imageSize.width / scaled.captureBounds.width;
    const imageY = (scaledBox!.y + scaledBox!.height / 2) * scaled.imageSize.height / scaled.captureBounds.height;
    await target.locator('body').evaluate(element => element.removeAttribute('data-coordinate'));
    await action('browser_click', { x: scaled.captureBounds.x + imageX * scaled.captureBounds.width / scaled.imageSize.width, y: scaled.captureBounds.y + imageY * scaled.captureBounds.height / scaled.imageSize.height });
    await expect(target.locator('body')).toHaveAttribute('data-coordinate', 'clicked');
  } finally { await emulation.send('Emulation.clearDeviceMetricsOverride'); await emulation.detach(); }
});

test('screenshot clips the current scrolled viewport and reports its document origin', async () => {
  await openFixture('/scroll');
  await target.evaluate(() => scrollTo(0, 1000));
  const screenshot = await action('browser_screenshot');
  expect(screenshot.captureBounds).toMatchObject({ x: 0, y: 0, pageX: 0, pageY: 1000, width: 1280, height: 900 });
  const pixel = await ui.evaluate(async (dataUrl: string) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0); const pixel = [...ctx.getImageData(Math.floor(image.width / 2), 80, 1, 1).data]; image.close(); return pixel;
  }, screenshot.dataUrl);
  expect(pixel[1]).toBeGreaterThan(180);
  expect(pixel[0]).toBeLessThan(20);
});

test('own extension pages and browser internal pages are rejected', async () => {
  await openFixture('/first');
  const tabs = await api('/api/tabs');
  const ownTab = tabs.find((tab: any) => tab.url === ui.url());
  expect(ownTab.controllable).toBe(false);
  const ownSnapshot = await rawApi('/api/browser', 'POST', { action: 'browser_snapshot', args: { tabId: ownTab.id } });
  expect(ownSnapshot.ok).toBe(false);
  expect(ownSnapshot.error).toMatch(/restricted|own app/i);
  const internalNavigation = await rawApi('/api/browser', 'POST', { action: 'browser_navigate', args: { tabId, url: 'chrome://settings/' } });
  expect(internalNavigation.ok).toBe(false);
  expect(target.url()).toBe(origin + '/first');
  const ownNavigation = await rawApi('/api/browser', 'POST', { action: 'browser_navigate', args: { tabId, url: ui.url() } });
  expect(ownNavigation.ok).toBe(false);
  expect(target.url()).toBe(origin + '/first');
});
