import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterGenerationError, CharacterGenerationService } from '../character-generation.js';
import type { CharacterGenerationOptions } from '../character-generation.js';
import { VISEMES } from '../shared.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = { bytes: png, mimeType: 'image/png' as const };
const imageResult = () => Response.json({ data: [{ b64_json: png.toString('base64') }] });
const concept = { name: 'Copper', description: 'A small copper robot.', imagePrompt: 'A friendly copper robot with a readable mouth.' };
const detectedRegions = {
  faceRegion: { x: 0.35, y: 0.1, width: 0.3, height: 0.3 },
  mouthRegion: { x: 0.43, y: 0.28, width: 0.14, height: 0.07 },
  leftEye: { x: 0.42, y: 0.2 }, rightEye: { x: 0.58, y: 0.2 }, confidence: 'high'
};
const conceptResult = (value: unknown = concept) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function service(fetcher: typeof fetch, options: CharacterGenerationOptions = {}) {
  return new CharacterGenerationService({ apiKey: 'test-key-never-live', imageModel: 'gpt-image-1.5', textModel: 'gpt-4.1-mini', fetch: fetcher, ...options });
}
function coded(code: string) {
  return (error: unknown) => error instanceof CharacterGenerationError && error.code === code;
}

test('speech generates a local opaque 3x3 mouth atlas from the supplied crop', async () => {
  let calls = 0;
  const generator = service(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/images/edits');
    assert.equal(init!.method, 'POST');
    assert.equal(init!.redirect, 'error');
    assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer test-key-never-live');
    assert.equal(new Headers(init!.headers).get('Content-Type'), null);
    assert.ok(init!.signal instanceof AbortSignal);
    const form = init!.body as FormData;
    assert.equal(form.get('model'), 'gpt-image-1.5');
    assert.equal(form.get('background'), 'opaque');
    assert.equal(form.get('output_format'), 'png');
    assert.equal(form.get('input_fidelity'), 'high');
    assert.equal(form.get('size'), '1024x1024');
    assert.equal(form.get('n'), '1');
    const inputs = form.getAll('image[]');
    assert.equal(inputs.length, 1);
    assert.deepEqual(Buffer.from(await (inputs[0] as File).arrayBuffer()), png);
    const prompt = String(form.get('prompt'));
    for (const pose of VISEMES) assert.ok(prompt.includes(`${pose}:`));
    assert.match(prompt, /EXACT crop/);
    assert.match(prompt, /Change ONLY the lips/);
    assert.match(prompt, /Do not draw or regenerate a full body/);
    assert.match(prompt, /Copper antenna/);
    return imageResult();
  });
  const result = await generator.generateMouthAtlas(source, 'Copper antenna');
  assert.equal(calls, 1, 'speech makes no full-body generation calls');
  assert.deepEqual(result, { png, columns: 3, rows: 3, frames: [...VISEMES] });
});

test('walking atlases keep repeatable four-frame cycles and support selected paid channels', async () => {
  for (const kinds of [undefined, [], ['enter'], ['exit']] as Array<Array<'enter' | 'exit'> | undefined>) {
    const prompts: string[] = [];
    const stages: string[] = [];
    const generator = service(async (_url, init) => {
      const form = init!.body as FormData;
      assert.equal(form.get('background'), 'transparent');
      prompts.push(String(form.get('prompt')));
      return imageResult();
    });
    const result = await generator.generateWalkAtlases(source, 'Copper antenna', { kinds, onProgress: stage => stages.push(stage) });
    const expected = kinds ?? ['enter', 'exit'];
    assert.equal(prompts.length, expected.length);
    assert.deepEqual(stages, expected);
    assert.deepEqual(Object.keys(result), expected);
    for (const kind of expected) assert.deepEqual(result[kind as 'enter' | 'exit'], { png, columns: 2, rows: 2, frames: ['1', '2', '3', '4'] });
    for (const prompt of prompts) {
      assert.match(prompt, /seamless repeatable walking cycle/);
      assert.match(prompt, /frame 4 opposite passing pose/);
      assert.match(prompt, /walks toward screen-right/);
      assert.match(prompt, /mirrors it for the selected direction/);
      assert.match(prompt, /Copper antenna/);
    }
  }
});

test('detection identifies a face before its mouth and requires associated eye landmarks', async () => {
  const generator = service(async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(body.store, false);
    assert.equal(body.text.format.name, 'character_speech_regions');
    assert.deepEqual(body.text.format.schema.required, ['faceRegion', 'mouthRegion', 'leftEye', 'rightEye', 'confidence']);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(body.input[0].content[0].type, 'input_image');
    assert.equal(body.input[0].content[0].image_url, `data:image/png;base64,${png.toString('base64')}`);
    assert.match(body.instructions, /Do not guess/);
    assert.match(body.instructions, /FACE.*FIRST/);
    assert.match(body.instructions, /guitars, guitar sound holes/);
    assert.match(body.instructions, /BELOW both eyes/);
    return conceptResult(detectedRegions);
  });
  const expected = { faceRegion: detectedRegions.faceRegion, mouthRegion: detectedRegions.mouthRegion };
  assert.deepEqual(await generator.detectSpeechRegions(source), expected);
  assert.deepEqual(await generator.locateMouth(source), expected.mouthRegion, 'legacy helper also uses face-first detection');
});

test('missing, oversized, tiny, nonnumeric, and out-of-bounds mouths fail instead of guessing', async () => {
  for (const value of [
    { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0.004, height: 0.1 }, { x: -0.1, y: 0, width: 0.1, height: 0.1 },
    { x: 0.95, y: 0, width: 0.1, height: 0.1 }, { x: 0, y: 0.95, width: 0.1, height: 0.1 },
    { x: '0.4', y: 0.2, width: 0.1, height: 0.1 }, { x: 0.4, y: 0.2, width: 0.1 },
    { x: 0.4, y: 0.2, width: 0.1, height: 0.1, surprise: true }, null
  ]) {
    let calls = 0;
    const generator = service(async () => { calls++; return conceptResult({ ...detectedRegions, mouthRegion: value }); });
    await assert.rejects(generator.locateMouth(source), coded('output'));
    assert.equal(calls, 1);
  }
  await assert.rejects(service(async () => Response.json({ status: 'incomplete', output: [] })).locateMouth(source), coded('output'));
});

test('guitar-height mouths, missing eyes, inverted landmarks and uncertain faces cannot become speech regions', async () => {
  for (const value of [
    { ...detectedRegions, mouthRegion: { x: 0.4, y: 0.6, width: 0.2, height: 0.1 } },
    { ...detectedRegions, mouthRegion: { x: 0.3, y: 0.28, width: 0.2, height: 0.07 } },
    { ...detectedRegions, confidence: 'uncertain' },
    { ...detectedRegions, confidence: 'high', leftEye: undefined },
    { ...detectedRegions, rightEye: { x: 0.9, y: 0.2 } },
    { ...detectedRegions, rightEye: detectedRegions.leftEye },
    { ...detectedRegions, leftEye: detectedRegions.rightEye, rightEye: detectedRegions.leftEye },
    { ...detectedRegions, leftEye: { x: 0.42, y: 0.3 } },
    { ...detectedRegions, mouthRegion: { x: 0.43, y: 0.19, width: 0.14, height: 0.04 } },
    { ...detectedRegions, faceRegion: { x: 0, y: 0, width: 1, height: 1 } },
    { ...detectedRegions, faceRegion: { x: 0.4, y: 0.2, width: 0.3 } },
    { ...detectedRegions, extra: true }, null
  ]) await assert.rejects(service(async () => conceptResult(value)).detectSpeechRegions(source), coded('output'));
});

test('a large portrait face can be detected without permitting a full-image edit', async () => {
  const portrait = {
    faceRegion: { x: 0.1, y: 0.05, width: 0.8, height: 0.8 },
    mouthRegion: { x: 0.3, y: 0.55, width: 0.3, height: 0.1 },
    leftEye: { x: 0.3, y: 0.3 }, rightEye: { x: 0.7, y: 0.3 }, confidence: 'high'
  };
  assert.deepEqual(await service(async () => conceptResult(portrait)).detectSpeechRegions(source), {
    faceRegion: portrait.faceRegion, mouthRegion: portrait.mouthRegion
  });
});

test('face speech edits the repeated source template through a matching PNG mask with fixed landmarks', async () => {
  const editRegion = { x: 0.15, y: 0.15, width: 0.7, height: 0.7 };
  const generator = service(async (_url, init) => {
    const form = init!.body as FormData;
    assert.equal(form.get('background'), 'opaque');
    const mask = form.get('mask') as File;
    assert.equal(mask.type, 'image/png');
    assert.deepEqual(Buffer.from(await mask.arrayBuffer()), png);
    const prompt = String(form.get('prompt'));
    assert.match(prompt, /EDIT THIS EXISTING SHEET IN PLACE/);
    assert.match(prompt, /ONLY editable facial oval/);
    assert.match(prompt, /entire final rest cell must remain unchanged/);
    assert.match(prompt, /x=0.15000, y=0.15000, width=0.70000, height=0.70000/);
    assert.match(prompt, /VERY SUBTLE coherent cheek and eyebrow expressions/);
    assert.match(prompt, /Preserve eye centers/);
    assert.match(prompt, /no head movement/);
    assert.match(prompt, /Do not zoom, recenter/);
    return imageResult();
  });
  assert.deepEqual(await generator.generateMouthAtlas(source, '', undefined, 'face', editRegion, source), {
    png, columns: 3, rows: 3, frames: [...VISEMES]
  });
});

test('speech masks and context edit coordinates are checked before any image request', async () => {
  let requests = 0;
  const generator = service(async () => { requests++; return imageResult(); });
  const wrongSize = Buffer.from(png);
  wrongSize.writeUInt32BE(2, 16);
  await assert.rejects(generator.generateMouthAtlas(source, '', undefined, 'face', undefined,
    { bytes: wrongSize, mimeType: 'image/png' }), coded('input'));
  await assert.rejects(generator.generateMouthAtlas(source, '', undefined, 'face',
    { x: 0.8, y: 0, width: 0.4, height: 0.4 }), coded('input'));
  await assert.rejects(generator.generateMouthAtlas(source, '', undefined, 'face',
    { x: NaN, y: 0, width: 0.4, height: 0.4 }), coded('input'));
  assert.equal(requests, 0);
});
test('optional concept uses Responses structured output and source generation uses the Images endpoint', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const generator = service(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).endsWith('/responses') ? conceptResult() : imageResult();
  });
  assert.deepEqual(await generator.generateConcept('Friendly robot'), concept);
  assert.deepEqual(await generator.generateSource(concept.imagePrompt), png);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.model, 'gpt-4.1-mini');
  assert.equal(calls[0].body.store, false);
  assert.deepEqual((calls[0].body.text as { format: { schema: { required: string[] } } }).format.schema.required, ['name', 'description', 'imagePrompt']);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[1].body.model, 'gpt-image-1.5');
  assert.equal(calls[1].body.background, 'transparent');
  assert.equal(calls[1].body.output_format, 'png');
  assert.equal(calls[1].body.n, 1);
  assert.equal('response_format' in calls[1].body, false, 'GPT Image returns base64 without the legacy parameter');
});

test('validates required credentials, prompts, MIME signatures, image sizes, and timeout before any network request', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return imageResult(); };
  const generator = service(fetcher);
  const absent = service(fetcher, { apiKey: '' });
  assert.equal(absent.configured, false);
  await assert.rejects(absent.generateSource('robot'), coded('configuration'));
  await assert.rejects(generator.generateSource(''), coded('input'));
  await assert.rejects(generator.generateConcept('x'.repeat(8193)), coded('input'));
  await assert.rejects(generator.generateWalkAtlases({ bytes: Buffer.from('bad image'), mimeType: 'image/png' }), coded('input'));
  await assert.rejects(generator.generateWalkAtlases({ bytes: png, mimeType: 'image/jpeg' }), coded('input'));
  await assert.rejects(generator.generateWalkAtlases({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: 'image/png' }), coded('input'));
  await assert.rejects(generator.generateWalkAtlases(source, 'x'.repeat(8193)), coded('input'));
  assert.throws(() => service(fetcher, { timeoutMs: Infinity }), coded('configuration'));
  assert.equal(requests, 0);
});

test('cancellation before and during a request is safe and stops later paid requests', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort(new Error('a private cancellation reason'));
  const generator = service(async () => { requests++; return imageResult(); });
  await assert.rejects(generator.generateWalkAtlases(source, '', { signal: controller.signal }), coded('cancelled'));
  assert.equal(requests, 0);

  const active = new AbortController();
  const hanging = service(async (_url, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('raw private fetch error')), { once: true });
      active.abort();
    });
  });
  await assert.rejects(hanging.generateWalkAtlases(source, '', { signal: active.signal }), error => {
    assert.ok(error instanceof CharacterGenerationError);
    assert.equal(error.code, 'cancelled');
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(requests, 1);
});

test('accepts two 4,000-character input fields with their separator and the 8,192-character service boundary', async () => {
  const combined = `${'d'.repeat(4000)}\n${'s'.repeat(4000)}`;
  const details = 'x'.repeat(8192);
  let requests = 0;
  const generator = service(async (url, init) => {
    requests++;
    if (String(url).endsWith('/responses')) {
      assert.equal(JSON.parse(String(init?.body)).input, combined);
      return conceptResult();
    }
    assert.ok(String((init!.body as FormData).get('prompt')).includes(details));
    return imageResult();
  });
  await generator.generateConcept(combined);
  await generator.generateWalkAtlases(source, details);
  assert.equal(requests, 3);
});

test('a request timeout aborts the fetch and does not automatically retry', async () => {
  let requests = 0;
  let aborted = false;
  const generator = service(async (_url, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('secret transport details')); }, { once: true }));
  }, { timeoutMs: 10 });
  await assert.rejects(generator.generateWalkAtlases(source), error => {
    assert.ok(error instanceof CharacterGenerationError);
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /API usage/);
    return true;
  });
  assert.equal(aborted, true);
  assert.equal(requests, 1);
});

test('provider and network errors never expose raw response text, prompts, or credentials and never retry', async () => {
  for (const [status, code] of [[401, 'authentication'], [403, 'access'], [429, 'rate_limit'], [400, 'rejected'], [503, 'service']] as const) {
    let requests = 0;
    const generator = service(async () => { requests++; return new Response('sk-private-example provider echoed a private prompt', { status }); });
    await assert.rejects(generator.generateWalkAtlases(source, 'private prompt'), error => {
      assert.ok(error instanceof CharacterGenerationError);
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error), /sk-private|test-key|private prompt/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
  }
  const generator = service(async () => { throw new Error('Bearer test-key-never-live proxy password'); });
  await assert.rejects(generator.generateSource('robot'), error => {
    assert.ok(error instanceof CharacterGenerationError);
    assert.equal(error.code, 'network');
    assert.doesNotMatch(String(error), /Bearer|test-key|password/);
    return true;
  });
});

test('rejects malformed, incomplete, or oversized image responses before returning partial walking results', async () => {
  for (const response of [
    () => Response.json({ data: [] }),
    () => Response.json({ data: [{ url: 'https://unexpected.example/image.png' }] }),
    () => Response.json({ data: [{ b64_json: 'not-base64' }] }),
    () => Response.json({ data: [{ b64_json: Buffer.from('not a PNG').toString('base64') }] }),
    () => new Response('not-json'),
    () => new Response('{}', { headers: { 'content-length': String(33 * 1024 * 1024) } })
  ]) {
    let requests = 0;
    const generator = service(async () => { requests++; return response(); });
    await assert.rejects(generator.generateWalkAtlases(source), coded('output'));
    assert.equal(requests, 1, 'invalid first atlas stops later requests');
  }
  let requests = 0;
  const generator = service(async () => ++requests === 1 ? imageResult() : Response.json({ data: [] }));
  await assert.rejects(generator.generateWalkAtlases(source), coded('output'));
  assert.equal(requests, 2, 'failed entrance atlas stops before the exit request');
});

test('rejects incomplete concepts and refusals instead of inventing source prompts', async () => {
  for (const response of [
    () => conceptResult({ name: 'Copper' }),
    () => conceptResult({ ...concept, surprise: true }),
    () => Response.json({ status: 'incomplete', output: [] }),
    () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Refused' }] }] })
  ]) await assert.rejects(service(async () => response()).generateConcept('robot'), coded('output'));
});

test('omits unsupported input_fidelity for newer image model overrides', async () => {
  const generator = service(async (_url, init) => {
    const form = init!.body as FormData;
    assert.equal(form.get('model'), 'gpt-image-2');
    assert.equal(form.has('input_fidelity'), false);
    return imageResult();
  }, { imageModel: 'gpt-image-2' });
  await generator.generateWalkAtlases(source);
});
