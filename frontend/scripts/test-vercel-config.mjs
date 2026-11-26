import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createVercelConfig, validateVercelConfig} from './vercel-config.mjs';

const fixtureRef = 'abcdefghijklmnopqrst';

test('only a project reference can select the HTTPS upstream', () => {
    for (const invalid of [
        undefined,
        '',
        'localhost',
        '../api',
        `${fixtureRef}.evil.test`,
        `https://${fixtureRef}.supabase.co`,
        `${fixtureRef}\n`,
        'A'.repeat(20),
    ]) {
        assert.throws(() => createVercelConfig(invalid), /SUPABASE_PROJECT_REF_INVALID/u);
    }
});

test('same-origin API routes retain their namespace without redirect or SPA fallback', () => {
    const config = createVercelConfig(fixtureRef);
    validateVercelConfig(config);
    assert.equal(config.rewrites.length, 1);
    assert.equal(config.rewrites[0].source, '/api/:path*');
    assert.equal(
        config.rewrites[0].destination,
        `https://${fixtureRef}.supabase.co/functions/v1/api/api/:path*`,
    );
    assert.equal(config.redirects, undefined);
    assert.equal(config.outputDirectory, 'dist/web');
});

test('CDN API caching is disabled without overriding browser public-data caching', () => {
    const config = createVercelConfig(fixtureRef);
    const apiHeaders = config.headers.find(({source}) => source === '/api/:path*').headers;
    assert.deepEqual(apiHeaders, [{key: 'x-vercel-enable-rewrite-caching', value: '0'}]);
    for (const source of ['/sw.js', '/manifest.webmanifest']) {
        assert.deepEqual(config.headers.find((rule) => rule.source === source).headers, [
            {key: 'Cache-Control', value: 'no-cache'},
        ]);
    }
});

test('validation rejects widened routing, caching and untrusted upstream changes', () => {
    for (const change of [
        (config) => {
            config.rewrites[0].destination = 'http://127.0.0.1/api/:path*';
        },
        (config) => {
            config.rewrites[0].source = '/:path*';
        },
        (config) => {
            config.headers[0].headers[0].value = '1';
        },
        (config) => {
            config.rewrites.push({source: '/:path*', destination: '/index.html'});
        },
    ]) {
        const config = createVercelConfig(fixtureRef);
        change(config);
        assert.throws(() => validateVercelConfig(config));
    }
});
