import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    delay: jest.fn(() => Promise.resolve()),
    trimTrailingSlash: (str) => String(str).replace(/\/+$/, ''),
}));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: jest.fn(() => 'test-api-key'),
    SECRET_KEYS: {
        MAKERSUITE: 'api_key_makersuite',
        VERTEXAI: 'api_key_vertexai',
        VERTEXAI_SERVICE_ACCOUNT: 'vertexai_service_account',
    },
}));

describe('Google image generation', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/google.js');
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { directories: {} };
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        fetchMock.mockReset();
    });

    const generate = (body) => fetch(`${baseUrl}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const geminiResponse = (parts) => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts } }] }),
    });

    test('Gemini image models use generateContent with image modality and return the inline image', async () => {
        fetchMock.mockResolvedValueOnce(geminiResponse([
            { text: 'Here is your image' },
            { inlineData: { mimeType: 'image/png', data: 'UE5H' } },
        ]));

        const response = await generate({
            model: 'gemini-3.1-flash-image',
            prompt: 'a cat',
            aspect_ratio: '16:9',
            image_size: '2K',
            seed: 42,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ image: 'UE5H', format: 'png' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/\/models\/gemini-3\.1-flash-image:generateContent$/);
        const body = JSON.parse(init.body);
        expect(body.contents[0].parts[0].text).toBe('a cat');
        expect(body.generationConfig.responseModalities).toEqual(['text', 'image']);
        expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
        expect(body.generationConfig.seed).toBe(42);
    });

    test('image_size is dropped for Gemini 2.5 image models', async () => {
        fetchMock.mockResolvedValueOnce(geminiResponse([
            { inlineData: { mimeType: 'image/jpeg', data: 'SlBH' } },
        ]));

        const response = await generate({
            model: 'gemini-2.5-flash-image',
            prompt: 'a dog',
            aspect_ratio: '1:1',
            image_size: '4K',
        });

        expect(await response.json()).toEqual({ image: 'SlBH', format: 'jpg' });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
        expect(body.generationConfig.seed).toBeUndefined();
    });

    test('Imagen models still use the predict endpoint', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ predictions: [{ bytesBase64Encoded: 'SU1H' }] }),
        });

        const response = await generate({ model: 'imagen-4.0-generate-001', prompt: 'a bird', aspect_ratio: '1:1' });

        expect(await response.json()).toEqual({ image: 'SU1H' });
        expect(fetchMock.mock.calls[0][0]).toMatch(/\/models\/imagen-4\.0-generate-001:predict$/);
    });

    test('reports an error when Gemini returns no image part', async () => {
        fetchMock.mockResolvedValueOnce(geminiResponse([{ text: 'refused' }]));

        const response = await generate({ model: 'gemini-3-pro-image', prompt: 'x' });

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('No image data found in response');
    });
});
