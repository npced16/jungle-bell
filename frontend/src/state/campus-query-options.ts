import {queryOptions} from '@tanstack/react-query';

import {
    type DashboardApi,
    parseDashboardLaundrySnapshot,
    parseDashboardMealsSnapshot,
} from '@/api/dashboard-api';

export const laundryQueryContract = {
    queryKey: ['campus', 'laundry'] as const,
    freshnessMs: 30_000,
    parse: parseDashboardLaundrySnapshot,
};

export const mealsQueryContract = {
    queryKey: ['campus', 'meals'] as const,
    freshnessMs: 5 * 60_000,
    parse: parseDashboardMealsSnapshot,
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const MEALTIME_REFRESH_MS = 60_000;

/** 식사 직전(KST 11:50~11:59, 17:50~17:59)에는 서버 수집과 맞춰 1분마다 갱신한다. */
export function mealsRefreshIntervalMs(reference = new Date()): number {
    const kst = new Date(reference.getTime() + KST_OFFSET_MS);
    const hour = kst.getUTCHours();
    const minute = kst.getUTCMinutes();
    if ((hour === 11 || hour === 17) && minute >= 50) return MEALTIME_REFRESH_MS;
    // 5분 간격이 구간 시작을 건너뛰지 않도록 다음 11:50/17:50까지만 기다린다.
    const msOfDay = kst.getTime() % 86_400_000;
    const untilWindow = [11, 17]
        .map((startHour) => (startHour * 60 + 50) * 60_000 - msOfDay)
        .filter((ms) => ms > 0);
    const nextWindow = untilWindow.length > 0 ? Math.min(...untilWindow) : Infinity;
    return Math.min(mealsQueryContract.freshnessMs, Math.max(nextWindow, 1_000));
}

export function laundryQueryOptions(api: Pick<DashboardApi, 'getPublicLaundry'>) {
    return queryOptions({
        queryKey: laundryQueryContract.queryKey,
        queryFn: () => api.getPublicLaundry(),
        staleTime: laundryQueryContract.freshnessMs,
        refetchInterval: laundryQueryContract.freshnessMs,
    });
}

export function mealsQueryOptions(api: Pick<DashboardApi, 'getPublicMeals'>) {
    return queryOptions({
        queryKey: mealsQueryContract.queryKey,
        queryFn: () => api.getPublicMeals(),
        staleTime: mealsQueryContract.freshnessMs,
        refetchInterval: () => mealsRefreshIntervalMs(),
    });
}
