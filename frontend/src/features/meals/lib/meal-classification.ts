import type {DashboardMealPost, DashboardMealsSnapshot} from '@/api/dashboard-api';
import {mealRecordPeriod} from '@/domain/meals/today';

export const mealPostGroups = ['주간 식단표', '중식', '석식', '기타 게시물'] as const;
export type MealPostGroup = (typeof mealPostGroups)[number];

export function mealPostGroup(post: DashboardMealPost): MealPostGroup {
    if (post.category === 'WEEKLY_MENU') return '주간 식단표';
    if (post.category === 'OTHER') return '기타 게시물';
    // 이전 서버 응답도 지원하되 고정 여부만으로 식단표라고 판단하지 않는다.
    if (post.category === undefined && /식단표/u.test(post.title ?? '')) return '주간 식단표';
    const period = mealRecordPeriod(post);
    return period === '중식' || period === '석식' ? period : '기타 게시물';
}

export function groupMealPosts(data: DashboardMealsSnapshot['data']) {
    const groups = new Map<MealPostGroup, DashboardMealPost[]>(
        mealPostGroups.map((key) => [key, []]),
    );
    const unique = new Map<string, DashboardMealPost>();
    for (const post of [
        ...(data.weeklyPosts ?? []),
        ...(data.otherPosts ?? []),
        ...data.dailyMenus,
        ...data.recentMenus,
        ...data.pinnedMenus,
        ...data.weeklyMenus.map((entry) => entry.post),
        ...(data.currentWeeklyMenu?.post ? [data.currentWeeklyMenu.post] : []),
    ]) {
        if (!unique.has(post.id)) unique.set(post.id, post);
    }
    for (const post of unique.values()) groups.get(mealPostGroup(post))!.push(post);
    return groups;
}
