import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {parseDashboardMealsSnapshot} from '@/api/dashboard-campus-contract';
import {mealRecordPeriod, mealServiceDate, selectTodayMeals} from '@/domain/meals/today';
import {homeTodayMealSlots} from '@/features/home/home-view-model';

import {groupMealPosts} from '../lib/meal-classification';
import {mealsGroupedByDate, todayMealSlots} from '../lib/meal-view';
import {MealPostGroups} from './meal-post-groups';

const makePost = (id: string, category: string, mealPeriod: string | null = null) => ({
    id,
    category,
    mealPeriod,
    mealDate: null,
    title: id,
    text: '보존된 전체 본문',
    publishedAt: '2026-10-19T00:00:00Z',
    permalink: 'https://pf.kakao.com/_xhzNjn/123',
    images: [
        {
            sha: 'a'.repeat(64),
            url: `https://jungle-bell.vercel.app/api/public/assets/${'a'.repeat(64)}.jpg`,
            contentType: 'image/jpeg',
            extension: 'jpg',
            width: 800,
            height: 1200,
            byteLength: 500,
        },
    ],
});
const raw = () => ({
    asOf: '2026-10-19T00:00:00Z',
    lastCheckedAt: null,
    data: {
        schemaVersion: 2,
        dailyMenus: [
            makePost('점심 사진', 'DAILY_MENU', 'LUNCH'),
            makePost('저녁 사진', 'DAILY_MENU', 'DINNER'),
        ],
        recentMenus: [makePost('점심 사진', 'DAILY_MENU', 'LUNCH')],
        pinnedMenus: [],
        currentWeeklyMenu: null,
        weeklyMenus: [],
        weeklyPosts: [makePost('주차 없는 식단표', 'WEEKLY_MENU')],
        otherPosts: [makePost('카페 이용 안내', 'OTHER')],
    },
});

describe('분류된 카카오 게시물 소비', () => {
    it('제목 없는 본문 분류도 홈·오늘·기록에서 중식과 석식 순서로 표시한다', () => {
        const value = raw();
        value.data.dailyMenus.reverse();
        for (const post of value.data.dailyMenus)
            Object.assign(post, {title: null, mealDate: '2026-10-19'});
        value.data.recentMenus = [];
        const snapshot = parseDashboardMealsSnapshot(value);
        const reference = new Date('2026-10-19T03:00:00Z');
        const today = selectTodayMeals(snapshot, reference);
        expect(today.map((post) => post.mealPeriod)).toEqual(['LUNCH', 'DINNER']);
        expect(
            homeTodayMealSlots(snapshot, reference)?.map((slot) => slot.meal?.mealPeriod),
        ).toEqual(['LUNCH', 'DINNER']);
        expect(todayMealSlots(today).map((slot) => slot.meal?.mealPeriod)).toEqual([
            'LUNCH',
            'DINNER',
        ]);
        expect(
            mealsGroupedByDate(snapshot.data.dailyMenus)
                .get('2026-10-19')
                ?.map((post) => post.mealPeriod),
        ).toEqual(['LUNCH', 'DINNER']);
    });
    it('주차 없는 주간표와 기타 공지를 보존하고 중복 게시물은 한 번 표시한다', () => {
        const snapshot = parseDashboardMealsSnapshot(raw(), 'https://jungle-bell.vercel.app');
        const groups = groupMealPosts(snapshot.data);
        expect([...groups].map(([label, posts]) => [label, posts.length])).toEqual([
            ['주간 식단표', 1],
            ['중식', 1],
            ['석식', 1],
            ['기타 게시물', 1],
        ]);
        const markup = renderToStaticMarkup(<MealPostGroups meals={snapshot} />);
        expect(markup.match(/<img /gu)).toHaveLength(4);
        expect(markup).toContain('object-contain');
        expect(markup).not.toContain('line-clamp-5');
        expect(markup).toContain('보존된 전체 본문');
        expect(markup).toContain('href="https://pf.kakao.com/_xhzNjn/123"');
        expect(markup).toContain('md:grid-cols-2');
    });
    it('명시 분류를 제목보다 우선하며 날짜 없는 급식을 오늘로 추정하지 않는다', () => {
        const snapshot = parseDashboardMealsSnapshot(raw());
        expect(mealRecordPeriod(snapshot.data.dailyMenus[0]!)).toBe('중식');
        expect(mealServiceDate(snapshot.data.dailyMenus[0]!)).toBeNull();
        expect(selectTodayMeals(snapshot, new Date('2026-10-19T03:00:00Z'))).toEqual([]);
    });
    it('알 수 없는 분류와 불가능한 급식일은 거부한다', () => {
        const value = raw();
        value.data.dailyMenus[0]!.category = 'INVENTED';
        expect(() => parseDashboardMealsSnapshot(value)).toThrow('API_RESPONSE_INVALID');
        const invalidDate = raw();
        Object.assign(invalidDate.data.dailyMenus[0]!, {mealDate: '2026-02-30'});
        expect(() => parseDashboardMealsSnapshot(invalidDate)).toThrow('API_RESPONSE_INVALID');
    });
});
