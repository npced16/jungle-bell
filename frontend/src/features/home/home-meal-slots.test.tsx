import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {HomeMealSlotsList} from './home-meal-slots';
import type {HomeMealSlots} from './home-view-model';

describe('HomeMealSlotsList', () => {
    it('오늘 메뉴의 사진과 전체 본문을 함께 표시한다', () => {
        const image = {
            sha: 'a'.repeat(64),
            url: `https://jungle-bell.vercel.app/api/public/assets/${'a'.repeat(64)}.jpg`,
            contentType: 'image/jpeg' as const,
            extension: 'jpg' as const,
            width: 800,
            height: 1200,
            byteLength: 500,
        };
        const html = renderToStaticMarkup(
            <HomeMealSlotsList
                slots={[
                    {
                        period: '중식',
                        meal: {
                            id: 'today',
                            title: null,
                            text: '원문 전체 메뉴',
                            publishedAt: null,
                            permalink: null,
                            images: [image],
                        },
                    },
                    {period: '석식', meal: null},
                ]}
            />,
        );
        expect(html).toContain('<img');
        expect(html).toContain(image.url);
        expect(html).toContain('원문 전체 메뉴');
        expect(html).toContain('object-contain');
        expect(html).not.toContain('line-clamp-2 font-medium');
    });
    it('keeps lunch above dinner and shows a visible empty state for a missing meal', () => {
        const slots: HomeMealSlots = [
            {
                period: '중식',
                meal: {
                    id: 'lunch',
                    title: '8월 11일 중식',
                    text: '비빔밥',
                    publishedAt: null,
                    permalink: null,
                },
            },
            {period: '석식', meal: null},
        ];

        const html = renderToStaticMarkup(<HomeMealSlotsList slots={slots} />);

        expect(html.indexOf('data-meal-period="중식"')).toBeLessThan(
            html.indexOf('data-meal-period="석식"'),
        );
        expect(html).toContain('data-meal-empty="false"');
        expect(html).toContain('data-meal-empty="true"');
        expect(html).toContain('data-meal-state="published"');
        expect(html).toContain('data-meal-state="empty"');
        expect(html).toContain('비빔밥');
        expect(html).toContain('아직 올라오지 않았습니다');
        expect(html).toMatch(/data-meal-state="published"[^>]*class="[^"]*text-foreground/);
        expect(html).toMatch(/data-meal-state="empty"[^>]*class="[^"]*bg-muted\/40/);
        expect(html).toMatch(/아직 올라오지 않았습니다<\/span>/);
        expect(html).not.toContain('data-slot="skeleton"');
        expect(html).not.toContain('메뉴 준비 중');
    });

    it('does not render an empty state when both fixed slots have meals', () => {
        const slots: HomeMealSlots = [
            {
                period: '중식',
                meal: {
                    id: 'lunch',
                    title: '8월 11일 중식',
                    text: '점심',
                    publishedAt: null,
                    permalink: null,
                },
            },
            {
                period: '석식',
                meal: {
                    id: 'dinner',
                    title: '8월 11일 석식',
                    text: '저녁',
                    publishedAt: null,
                    permalink: null,
                },
            },
        ];

        const html = renderToStaticMarkup(<HomeMealSlotsList slots={slots} />);

        expect(html).not.toContain('data-slot="skeleton"');
        expect(html).not.toContain('data-meal-state="empty"');
        expect(html).not.toContain('data-meal-empty="true"');
    });
});
