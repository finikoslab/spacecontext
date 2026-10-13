import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeScan,
  fetchCaptureProfile,
  fetchCaptureProfiles,
  SPACE_TYPES,
  SpaceContext,
  SpaceContextError,
  summarizeCoverage,
  summarizeVerification,
  type CaptureProfile,
  type SpaceVerification,
} from '../src/index.js';

const LIVE = 'sc_live_abcdefghijklmnop';
const TEST = 'sc_test_abcdefghijklmnop';
const BASE = 'https://api.example.test/v1';

type Call = { url: string; method: string; headers: Record<string, string>; redirect: string | undefined };

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), redirect: init.redirect };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const VEHICLE: CaptureProfile = {
  object: 'capture_profile',
  space_type: 'vehicle',
  language: 'en',
  key_locations: [
    { kind: 'identification_plate', label: 'Identification plate', hint: 'The VIN plate', expected: true },
    { kind: 'instrument_panel', label: 'Dashboard', hint: 'The odometer', expected: true },
    { kind: 'engine_bay', label: 'Engine bay', hint: 'Bonnet open', expected: true },
    { kind: 'spare_wheel', label: 'Spare wheel', hint: 'In the boot', expected: false },
    { kind: 'first_aid', label: 'First aid kit', hint: 'If there is one', expected: false },
  ],
  areas: [{ value: 'exterior_front', label: 'Front' }],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('guided capture', () => {
  it('lists the eleven types of space in the API order', () => {
    expect(SPACE_TYPES).toEqual(['apartment', 'house', 'office', 'warehouse', 'vehicle', 'boat', 'camper', 'shop', 'garage', 'appliance', 'other']);
  });

  it('checks a frame for a type of space with space_type in the query', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ object: 'frame_check', livemode: true, space_type: 'vehicle', usable: true, quality: { score: 2, level: 'good' }, shows_space: 0.98, area: { value: 'interior_front', probability: 0.81 }, key_locations: [] })
    );
    const sc = new SpaceContext({ apiKey: LIVE, baseUrl: BASE, fetch });
    const check = await sc.frames.check(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg', { spaceType: 'vehicle' });
    expect(calls[0]!.url).toBe(`${BASE}/frames/check?space_type=vehicle`);
    expect(check.area).toEqual({ value: 'interior_front', probability: 0.81 });
    await sc.frames.check(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
    expect(calls[1]!.url).toBe(`${BASE}/frames/check`);
  });

  it('reads the capture profiles on the client without sending the key', async () => {
    const { fetch, calls } = fakeFetch((call) => (call.url.includes('/vehicle') ? json(VEHICLE) : json({ object: 'list', data: [VEHICLE] })));
    const sc = new SpaceContext({ apiKey: TEST, baseUrl: BASE, fetch });
    const list = await sc.captureProfiles.list({ language: 'it' });
    const one = await sc.captureProfiles.get('vehicle');
    expect(list.data[0]!.space_type).toBe('vehicle');
    expect(one.key_locations).toHaveLength(5);
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/capture-profiles?language=it`, `${BASE}/capture-profiles/vehicle`]);
    for (const call of calls) {
      expect(call.headers.authorization).toBeUndefined();
      expect(call.redirect).toBe('manual');
    }
    // The key still goes to the API's other routes.
    await sc.frames.check(new Uint8Array([1]), 'image/jpeg').catch(() => undefined);
    expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${TEST}`);
  });

  it('reads them with no key at all, only over https, and maps errors', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.includes('castle') ? json({ error: { code: 'NOT_FOUND', message: 'No such type', request_id: 'req_1' } }, 404) : json(VEHICLE)
    );
    const profile = await fetchCaptureProfile('vehicle', { baseUrl: BASE, fetch, language: 'en' });
    expect(profile.space_type).toBe('vehicle');
    await fetchCaptureProfiles({ baseUrl: `${BASE}/`, fetch });
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/capture-profiles/vehicle?language=en`, `${BASE}/capture-profiles`]);
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);

    await expect(fetchCaptureProfile('castle' as never, { baseUrl: BASE, fetch })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(fetchCaptureProfiles({ baseUrl: 'http://api.example.test/v1', fetch })).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
    await expect(fetchCaptureProfiles({ baseUrl: 'http://localhost:8787/v1', fetch })).resolves.toBeTruthy();

    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const error = await fetchCaptureProfiles({ baseUrl: BASE, fetch: failing }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpaceContextError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });

    vi.stubEnv('SPACECONTEXT_BASE_URL', 'https://staging.example.test/v1');
    await fetchCaptureProfiles({ fetch });
    expect(calls.at(-1)!.url).toBe('https://staging.example.test/v1/capture-profiles');
  });

  it('summarises the coverage, split by the profile into usually there and if there is one', () => {
    const document = {
      coverage: {
        checklist: [
          { kind: 'identification_plate', seen: false, probability: 0.2, evidence: [] },
          { kind: 'instrument_panel', seen: true, probability: 0.97, evidence: [] },
          { kind: 'engine_bay', seen: true, probability: 0.92, evidence: [] },
          { kind: 'spare_wheel', seen: false, probability: 0.1, evidence: [] },
          { kind: 'first_aid', seen: false, probability: 0.0, evidence: [] },
        ],
      },
    } as Parameters<typeof summarizeCoverage>[0];
    expect(summarizeCoverage(document, VEHICLE)).toEqual({
      checked: true,
      seen: ['instrument_panel', 'engine_bay'],
      missing: ['identification_plate', 'spare_wheel', 'first_aid'],
      missingExpected: ['identification_plate'],
      missingOptional: ['spare_wheel', 'first_aid'],
    });
    expect(summarizeCoverage(document).missingOptional).toEqual(['identification_plate', 'spare_wheel', 'first_aid']);
    expect(summarizeCoverage(document).missingExpected).toEqual([]);
    expect(summarizeCoverage({ coverage: { checklist: [] } })).toMatchObject({ checked: false, seen: [], missing: [] });
  });

  it('counts the records confirmed on their own photo', () => {
    const v = (status: SpaceVerification['status'] | null) =>
      ({ verification: status ? { status, probability: status === 'not_visual' ? null : 0.9, frame_id: status === 'not_visual' ? null : 'frame-1' } : null });
    expect(
      summarizeVerification({ items: [v('verified'), v('verified'), v('unconfirmed'), v(null)], issues: [v('not_visual'), v('verified')], key_locations: [v('unconfirmed'), {}] })
    ).toEqual({ total: 8, verified: 3, unconfirmed: 2, notVisual: 1, unchecked: 2 });
    expect(summarizeVerification({ items: [], issues: [], key_locations: [] })).toEqual({ total: 0, verified: 0, unconfirmed: 0, notVisual: 0, unchecked: 0 });
  });

  it('names the verification stage of a running scan', () => {
    expect(describeScan({ status: 'processing', stage: 'verifying' })).toEqual({ stage: 'verifying', label: 'Verifying the evidence' });
  });
});
