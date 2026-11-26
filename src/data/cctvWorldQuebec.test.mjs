import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WORLD_CCTV_SOURCE_FILE,
  WORLD_CCTV_SOURCE_COUNT,
} from '../../server/providers/cctv/constants.js';
import {
  isMlitRiverAdjustmentImage,
  loadWorldCameraSources,
} from '../../server/providers/cctv/worldCameras.js';
import {
  loadQuebecSources,
  QUEBEC_CAMERA_SOURCE_COUNT,
  quebec511VideoUrl,
  quebecBrowserVideoEnabled,
} from '../../server/providers/cctv/quebec.js';
import { cctvProxy } from '../../server/providers/cctv.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** A temporary source root holding the given World and Québec catalogs. */
function sourceRoot(t, { world = [], quebec = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-world-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worldFile = path.join(root, DEFAULT_WORLD_CCTV_SOURCE_FILE);
  fs.mkdirSync(path.dirname(worldFile), { recursive: true });
  fs.writeFileSync(worldFile, JSON.stringify(world));
  if (quebec) {
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'public/quebec-cameras.json'),
      JSON.stringify({ cameras: quebec }),
    );
  }
  return root;
}

const oregonRow = (overrides = {}) => ({
  id: 'world-or-764',
  name: '3rd St at Harwood MP18.35',
  provider: 'TripCheck (ODOT)',
  lat: 44.3029,
  lon: -120.8549,
  sourceKind: 'tripcheck-odot',
  url: 'https://www.tripcheck.com/roadcams/cams/Harwood_pid3527.jpg',
  snapshotUrl: 'https://www.tripcheck.com/roadcams/cams/Harwood_pid3527.jpg',
  ...overrides,
});

const davaoRow = {
  id: 'ph-davao-test',
  name: 'Test camera',
  lat: 7.07,
  lon: 125.61,
  provider: 'Test provider',
  license: 'Mock data',
  sourceUrl: 'https://cameras.example.test/about',
  url: 'https://cameras.example.test/frame.jpg',
};

test('the shipped World catalog loads every curated row', (t) => {
  quiet(t);
  const sources = loadWorldCameraSources({ sourceRoot: REPO_ROOT });
  assert.equal(sources.length, WORLD_CCTV_SOURCE_COUNT);
  const byKind = Object.groupBy(sources, (source) => source.sourceKind);
  // Iceland comes from the live Iceland pack, never a second World copy.
  assert.equal(byKind['vegagerdin-road'], undefined);
  assert.equal(byKind['tripcheck-odot'].length, 1176);
  assert.equal(byKind['mlit-river'].length, 1054);
  for (const source of byKind['mlit-river'])
    assert.equal(source.frameRefreshMs, 10 * 60 * 1000);
});

test('the World loader accepts a pinned row and rejects anything outside its policy', (t) => {
  quiet(t);
  const rejected = [
    ['unknown kind', { sourceKind: 'nzta-journeys' }],
    [
      'Iceland duplicates the Iceland pack',
      {
        sourceKind: 'vegagerdin-road',
        lat: 64.291877,
        lon: -15.028035,
        url: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/almannaskard_1.jpg',
        snapshotUrl: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/almannaskard_1.jpg',
      },
    ],
    ['wrong id prefix', { id: 'world-jp-river-7075' }],
    ['outside bounds', { lat: 40, lon: -15 }],
    ['other host', { url: 'https://evil.test/roadcams/cams/a.jpg' }],
    ['other directory', { url: 'https://www.tripcheck.com/other/a.jpg' }],
    ['query string', { url: oregonRow().url + '?x=1' }],
    ['not a jpg', { url: 'https://www.tripcheck.com/roadcams/cams/a.png' }],
    ['plain http', { url: oregonRow().url.replace('https:', 'http:') }],
    [
      'url and snapshot differ',
      { snapshotUrl: 'https://www.tripcheck.com/roadcams/cams/b.jpg' },
    ],
  ];
  const root = sourceRoot(t, {
    world: [
      oregonRow(),
      oregonRow(), // duplicate id
      ...rejected.map(([, overrides], i) =>
        oregonRow({ id: `world-or-${9000 + i}`, ...overrides }),
      ),
    ],
  });
  const sources = loadWorldCameraSources({ sourceRoot: root });
  assert.deepEqual(
    sources.map((source) => source.id),
    ['world-or-764'],
  );
  assert.equal(sources[0].frameRefreshMs, 5 * 60 * 1000);
  assert.equal(sources[0].feedType, 'image');
});

test('the World loader fails soft on a missing or malformed catalog', (t) => {
  quiet(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-world-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadWorldCameraSources({ sourceRoot: root }), []);
  const file = path.join(root, DEFAULT_WORLD_CCTV_SOURCE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadWorldCameraSources({ sourceRoot: root }), []);
});

test('only the exact MLIT adjustment image is recognised', () => {
  assert.equal(isMlitRiverAdjustmentImage({ ok: true, body: JPEG }), false);
  assert.equal(isMlitRiverAdjustmentImage(null), false);
  assert.equal(isMlitRiverAdjustmentImage({ ok: false, body: JPEG }), false);
});

test('the shipped Québec catalog loads every location', (t) => {
  quiet(t);
  const sources = loadQuebecSources({ sourceRoot: REPO_ROOT });
  assert.equal(sources.length, QUEBEC_CAMERA_SOURCE_COUNT);
  for (const source of sources) {
    assert.equal(source.url, '', 'the server never fetches Québec media');
    assert.equal(source.snapshotUrl, '');
  }
});

test('the Québec loader maps ids by kind, keeps https viewer links, and splits the MTQ credit', (t) => {
  quiet(t);
  const at = { lat: 45.51651, lon: -73.5502 };
  const root = sourceRoot(t, {
    quebec: [
      { id: '3735', kind: 'traffic', name: 'Route 136', viewerUrl: 'https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3735', ...at },
      { id: 'mtl-465', kind: 'montreal', name: 'Montréal 465', viewerUrl: 'http://ville.montreal.qc.ca/x', ...at },
      { id: 'web-1', kind: 'webcam', name: 'Tremblant', operator: 'Station Mont-Tremblant', viewerUrl: 'https://user:pw@tremblant.ca/', ...at },
      { id: 'abc', kind: 'traffic', ...at }, // non-numeric traffic id
      { id: '3735', kind: 'traffic', ...at }, // duplicate
      { id: '9', kind: 'traffic', lat: 40, lon: -73.5 }, // outside Québec
    ],
  });
  const sources = loadQuebecSources({ sourceRoot: root });
  const byId = new Map(sources.map((source) => [source.id, source]));
  assert.deepEqual([...byId.keys()], ['qc-511-3735', 'qc-mtl-465', 'qc-web-1']);

  const mtq = byId.get('qc-511-3735');
  assert.equal(mtq.sourceKind, 'quebec-511-browser');
  assert.match(mtq.credit, /Locations: MTQ · CC BY 4\.0/);
  assert.match(mtq.credit, /Video: Québec 511/);
  assert.doesNotMatch(mtq.license, /^Données Québec \/ MTQ, CC BY 4\.0$/);
  assert.equal(byId.get('qc-mtl-465').sourceUrl, '', 'http viewer links are dropped');
  assert.equal(byId.get('qc-web-1').sourceUrl, '', 'credentialed links are dropped');
  assert.equal(
    quebec511VideoUrl('qc-511-3735'),
    'https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=3735&format=mp4',
  );
  assert.equal(quebec511VideoUrl('qc-mtl-465'), '');
});

test('Québec 511 browser video is opt-in', () => {
  assert.equal(quebecBrowserVideoEnabled({}), false);
  assert.equal(quebecBrowserVideoEnabled({ CCTV_QUEBEC_VIDEO_ENABLED: '0' }), false);
  assert.equal(quebecBrowserVideoEnabled({ CCTV_QUEBEC_VIDEO_ENABLED: ' 1 ' }), true);
});

/** Mount the real proxy with a fixed fetch, and drive requests through it. */
function mount(t, root, respond) {
  withEnv(t, {
    CCTV_SOURCES_FILE: 'absent-source-file.json',
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: '0',
    CCTV_MAX_SOURCES: undefined,
    // A configured key makes any Street View fallback observable.
    GOOGLE_MAPS_SERVER_API_KEY: 'test-google-key',
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push(String(url));
    return respond(String(url), init) || new Response('down', { status: 503 });
  });
  let handler;
  cctvProxy({ sourceRoot: root }).configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  const call = async (url) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
      on() {},
      once() {},
    };
    await handler({ url, method: 'GET', headers: {}, on() {} }, res);
    return res;
  };
  return { call, requests };
}

test('an authorized Davao pack is served alongside the World pack', async (t) => {
  quiet(t);
  const world = oregonRow();
  const root = sourceRoot(t, { world: [world] });
  fs.writeFileSync(
    path.join(root, 'davao.json'),
    JSON.stringify([
      davaoRow,
      { ...davaoRow, id: 'ph-davao-unlicensed', license: '' },
      { ...davaoRow, id: 'ph-davao-outside', lat: 1 },
      {
        ...davaoRow,
        id: 'ph-davao-credentialed',
        url: 'https://a:b@example.test/cam',
      },
    ]),
  );
  withEnv(t, {
    CCTV_DAVAO_SOURCES_FILE: 'davao.json',
    CCTV_PREFER_AUSTIN: '1',
    CCTV_WORLD_CAMERAS_ENABLED: '1',
  });
  const app = mount(t, root, (url) =>
    url === davaoRow.url
      ? new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
      : null,
  );
  const { sources } = JSON.parse((await app.call('/sources')).body);
  assert.deepEqual(
    sources.map(({ id, pack }) => ({ id, pack })),
    [
      { id: world.id, pack: 'world-cameras' },
      { id: davaoRow.id, pack: 'davao' },
    ],
  );
  assert.equal(sources[1].city, 'Davao City');
  assert.equal(sources[1].license, davaoRow.license);
  const frame = await app.call(`/frame/${davaoRow.id}`);
  assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
  assert.deepEqual(frame.body, JPEG);
});

test('Davao only uses spare slots and keeps every existing camera at the cap', async (t) => {
  quiet(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('down', { status: 503 }),
  );
  const world = Array.from({ length: 8 }, (_, i) =>
    oregonRow({ id: `world-or-${i}` }),
  );
  const root = sourceRoot(t, { world });
  fs.writeFileSync(path.join(root, 'davao.json'), JSON.stringify([davaoRow]));
  withEnv(t, {
    CCTV_DAVAO_SOURCES_FILE: 'davao.json',
    CCTV_MAX_SOURCES: '8',
    CCTV_SOURCES_FILE: 'absent-source-file.json',
    CCTV_SOURCES_JSON: undefined,
    CCTV_PREFER_AUSTIN: '1',
    CCTV_WORLD_CAMERAS_ENABLED: '1',
  });
  const getSources = createCctvCatalog({ sourceRoot: root });
  const capped = await getSources();
  assert.deepEqual(
    capped.map(({ id }) => id),
    world.map(({ id }) => id),
  );
  const [trimmed] = getSources.trimmedPacks(capped);
  assert.deepEqual(
    { ...trimmed, region: undefined },
    {
      pack: 'davao',
      available: 1,
      served: 0,
      region: undefined,
    },
  );

  process.env.CCTV_MAX_SOURCES = '9';
  const expanded = await createCctvCatalog({ sourceRoot: root })();
  assert.deepEqual(
    expanded.map(({ id }) => id),
    [...world.map(({ id }) => id), davaoRow.id],
  );
});

test('/sources lists Québec browser media only when the operator opts in', async (t) => {
  quiet(t);
  const root = sourceRoot(t, {
    quebec: [{ id: '3735', kind: 'traffic', name: 'Route 136', lat: 45.5, lon: -73.5 }],
  });
  withEnv(t, { CCTV_QUEBEC_VIDEO_ENABLED: undefined });
  const app = mount(t, root, () => null);
  const off = JSON.parse((await app.call('/sources')).body).sources;
  assert.equal(off.find((s) => s.id === 'qc-511-3735').browserMediaUrl, '');

  process.env.CCTV_QUEBEC_VIDEO_ENABLED = '1';
  const on = JSON.parse((await app.call('/sources')).body).sources;
  assert.match(on.find((s) => s.id === 'qc-511-3735').browserMediaUrl, /camera\.ashx\?id=3735&format=mp4$/);
});

test('a World frame is fetched once per refresh floor and the cooldown never spends Street View', async (t) => {
  quiet(t);
  const root = sourceRoot(t, { world: [oregonRow()] });
  let answer = () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
  const app = mount(t, root, (url) =>
    url === oregonRow().url ? answer() : null,
  );
  const frame = '/frame/world-or-764';
  const upstreamHits = () =>
    app.requests.filter((url) => url === oregonRow().url).length;

  const first = await app.call(frame);
  assert.equal(first.headers['X-CCTV-Source'], 'upstream-image');
  const second = await app.call(frame);
  assert.equal(second.headers['X-CCTV-Source'], 'upstream-image');
  assert.equal(upstreamHits(), 1, 'the second view reuses the cached frame');

  // A camera whose first fetch fails is inside its failure backoff: it gets
  // the placeholder, not Google Street View, and no second upstream request.
  const failRoot = sourceRoot(t, { world: [oregonRow()] });
  answer = () => new Response('down', { status: 503 });
  const failing = mount(t, failRoot, (url) =>
    url === oregonRow().url ? answer() : null,
  );
  const failed = await failing.call(frame);
  assert.notEqual(failed.headers['X-CCTV-Source'], 'upstream-image');
  const retry = await failing.call(frame);
  assert.equal(retry.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(
    failing.requests.filter((url) => url === oregonRow().url).length,
    1,
    'the backoff holds the provider cadence',
  );
  assert.equal(
    failing.requests.filter((url) => url.includes('maps.googleapis.com/maps/api/streetview')).length,
    1,
    'only the first miss, outside any cooldown, may try Street View',
  );
});

test('Ottawa frames are signed with the certificate at fetch time only', async (t) => {
  quiet(t);
  const root = sourceRoot(t);
  withEnv(t, { OTTAWA_CAMERA_CERTIFICATE: 'CERT123' });
  const app = mount(t, root, (url) => {
    if (url === 'https://traffic.ottawa.ca/map/service/camera')
      return Response.json({
        cameras: [
          { camera_number: 16, name: 'Bank & Hunt Club', latitude: 45.35, longitude: -75.65, cameraOwner: 'CITY' },
        ],
      });
    if (url.startsWith('https://traffic.ottawa.ca/opendata/camera'))
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    return null;
  });
  const sources = JSON.parse((await app.call('/sources')).body).sources;
  const ottawa = sources.find((source) => source.id === 'ottawa-16');
  assert.ok(ottawa);
  assert.doesNotMatch(JSON.stringify(sources), /CERT123/, 'no catalog field carries the certificate');

  const frame = await app.call('/frame/ottawa-16');
  assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
  await app.call('/frame/ottawa-16');
  const hits = app.requests.filter((url) => url.includes('/opendata/camera'));
  assert.deepEqual(hits, [
    'https://traffic.ottawa.ca/opendata/camera?c=16&certificate=CERT123&id=gev',
  ], 'one signed request per camera per minute');
});
