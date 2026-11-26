import {expect, it} from 'vitest';

import {normalizeExternalUrl} from './external-link-policy';

it('운영자 저장소와 피드백만 정확히 허용한다', () => {
    for (const url of [
        'https://github.com/npced16/jungle-bell',
        'https://github.com/npced16/jungle-bell/issues/new/choose',
        'https://github.com/npced16/jungle-bell/issues/new?template=feature_request.yml',
    ]) {
        expect(normalizeExternalUrl(url)).toBe(url);
    }
    expect(() => normalizeExternalUrl('https://github.com/npced16/another-repo')).toThrow(
        'EXTERNAL_URL_NOT_ALLOWED',
    );
    for (const url of [
        'https://github.com/npced16/jungle-bell/issues/new?template=evil.yml',
        'https://github.com/npced16/jungle-bell/issues/new?template=feature_request.yml&redirect=evil',
    ]) {
        expect(() => normalizeExternalUrl(url)).toThrow('EXTERNAL_URL_NOT_ALLOWED');
    }
});

it('새 서비스의 저장 이미지 경로만 허용한다', () => {
    const path = `/api/public/assets/${'a'.repeat(64)}.jpg`;
    expect(normalizeExternalUrl(`https://jungle-bell.vercel.app${path}`)).toBe(
        `https://jungle-bell.vercel.app${path}`,
    );
    for (const value of [
        `https://another.vercel.app${path}`,
        `https://jungle-bell.vercel.app.evil.com${path}`,
        'https://jungle-bell.vercel.app/settings',
        `https://jungle-bell.vercel.app${path}?redirect=evil`,
    ])
        expect(() => normalizeExternalUrl(value)).toThrow('EXTERNAL_URL_NOT_ALLOWED');
});
