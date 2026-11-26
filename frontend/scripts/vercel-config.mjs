import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const configPath = fileURLToPath(new URL('../vercel.json', import.meta.url));

// This is a pre-deployment preparation command, never a Vercel build step.
export function createVercelConfig(projectRef) {
    if (typeof projectRef !== 'string' || !/^[a-z0-9]{20}$/u.test(projectRef)) {
        throw new Error('SUPABASE_PROJECT_REF_INVALID');
    }
    return {
        $schema: 'https://openapi.vercel.sh/vercel.json',
        framework: 'vite',
        installCommand: 'npm ci',
        buildCommand: 'npm run build:web',
        outputDirectory: 'dist/web',
        rewrites: [
            {
                source: '/api/:path*',
                destination: `https://${projectRef}.supabase.co/functions/v1/api/api/:path*`,
            },
        ],
        headers: [
            {
                source: '/api/:path*',
                headers: [{key: 'x-vercel-enable-rewrite-caching', value: '0'}],
            },
            {
                source: '/sw.js',
                headers: [{key: 'Cache-Control', value: 'no-cache'}],
            },
            {
                source: '/manifest.webmanifest',
                headers: [{key: 'Cache-Control', value: 'no-cache'}],
            },
        ],
    };
}

export function validateVercelConfig(config) {
    const destination = config?.rewrites?.[0]?.destination;
    const match =
        typeof destination === 'string' &&
        /^https:\/\/([a-z0-9]{20})\.supabase\.co\/functions\/v1\/api\/api\/:path\*$/u.exec(
            destination,
        );
    if (!match) throw new Error('VERCEL_API_DESTINATION_INVALID');
    assert.deepEqual(config, createVercelConfig(match[1]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, projectRef, ...extra] = process.argv.slice(2);
    if (command === 'create' && extra.length === 0) {
        writeFileSync(configPath, `${JSON.stringify(createVercelConfig(projectRef), null, 4)}\n`, {
            flag: 'wx',
        });
    } else if (command === 'check' && projectRef === undefined) {
        validateVercelConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    } else {
        throw new Error(
            'Usage: node scripts/vercel-config.mjs create <confirmed-project-ref> | check',
        );
    }
}
