import type {
    AttendanceDashboard,
    AttendanceData,
    DashboardLaundrySnapshot,
    DashboardMealPost,
    DashboardMealsSnapshot,
} from '@/api/dashboard-api';
import {effectiveAttendanceDate} from '@/domain/attendance/attendance-day';
import {ATTENDANCE_FRESHNESS_MS} from '@/domain/attendance/freshness';
import {laundryCapacity} from '@/domain/laundry/capacity';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {laundryAvailabilityState} from '@/domain/laundry/status';
import {
    kstDateKey,
    mealServiceDate,
    mealRecordPeriod,
    selectTodayMeals,
} from '@/domain/meals/today';

export interface LaundryHomeSummary {
    men: number | null;
    women: number | null;
}

export type HomeMealPeriod = '중식' | '석식';

export interface HomeMealSlot {
    period: HomeMealPeriod;
    meal: DashboardMealPost | null;
}

export type HomeMealSlots = readonly [HomeMealSlot, HomeMealSlot];

type AvailableAttendance = Extract<AttendanceData, {status: 'available'}>;

export type HomeAttendanceState =
    | {kind: 'unavailable'}
    | {kind: 'current'; attendance: AvailableAttendance}
    | {kind: 'stale'; attendance: AvailableAttendance}
    | {kind: 'different-attendance-day'; attendance: AvailableAttendance};

export function homeAttendanceState(
    dashboard?: AttendanceDashboard,
    reference = new Date(),
): HomeAttendanceState {
    if (!dashboard || dashboard.state !== 'loaded') return {kind: 'unavailable'};
    const attendance = dashboard.attendance;
    if (attendance.status !== 'available') return {kind: 'unavailable'};
    if (attendance.snapshot.attendanceDate !== effectiveAttendanceDate(reference.getTime())) {
        return {kind: 'different-attendance-day', attendance};
    }
    const localObservationExpired =
        attendance.source === 'desktop' &&
        reference.getTime() - Date.parse(attendance.lastSyncedAt) > ATTENDANCE_FRESHNESS_MS;
    if (attendance.freshness !== 'fresh' || localObservationExpired) {
        return {kind: 'stale', attendance};
    }
    return {kind: 'current', attendance};
}

export function homeLaundrySummary(input: {
    snapshot: DashboardLaundrySnapshot;
    nowMs?: number;
}): LaundryHomeSummary {
    const snapshot = input.snapshot;
    const savedAt = Date.parse(snapshot.asOf);
    const locallyReliable =
        snapshot.quality.collectorHealthy &&
        snapshot.quality.collection === 'SUCCESS' &&
        laundrySituationDataIsReliable({
            hasData: snapshot.machines.length > 0,
            error: null,
            sourceFreshness: snapshot.quality.sourceFreshness,
            expectedRefreshIntervalSeconds: snapshot.quality.expectedRefreshIntervalSeconds,
            snapshotSavedAt: savedAt,
            nowMs: input.nowMs ?? Date.now(),
        });
    const capacity = laundryCapacity(snapshot.capacity, locallyReliable);
    return capacity;
}

export function homeLaundryAvailability(
    snapshot: DashboardLaundrySnapshot,
    nowMs = Date.now(),
    fetchFailed = false,
) {
    const reliable =
        !fetchFailed &&
        snapshot.quality.collectorHealthy &&
        snapshot.quality.collection === 'SUCCESS' &&
        laundrySituationDataIsReliable({
            hasData: snapshot.machines.length > 0,
            error: null,
            sourceFreshness: snapshot.quality.sourceFreshness,
            expectedRefreshIntervalSeconds: snapshot.quality.expectedRefreshIntervalSeconds,
            snapshotSavedAt: Date.parse(snapshot.asOf),
            nowMs,
        });
    const count = (type: 'washer' | 'dryer') =>
        snapshot.machines.filter(
            (machine) => laundryAvailabilityState(machine[type]) === 'available',
        ).length;
    return {
        reliable,
        washerTotal: snapshot.machines.filter((machine) => machine.washer !== null).length,
        dryerTotal: snapshot.machines.filter((machine) => machine.dryer !== null).length,
        washers: reliable ? count('washer') : null,
        dryers: reliable ? count('dryer') : null,
    };
}

export function homeTodayMeals(
    snapshot?: DashboardMealsSnapshot,
    reference = new Date(),
): DashboardMealPost[] {
    if (!snapshot) return [];
    return selectTodayMeals(snapshot, reference).slice(0, 4);
}

export function homeTodayMealSlots(
    snapshot?: DashboardMealsSnapshot,
    reference = new Date(),
): HomeMealSlots | null {
    const mealsByPeriod = new Map<HomeMealPeriod, DashboardMealPost>();
    for (const meal of homeTodayMeals(snapshot, reference)) {
        const period = mealPeriodLabel(meal);
        if ((period === '중식' || period === '석식') && !mealsByPeriod.has(period)) {
            mealsByPeriod.set(period, meal);
        }
    }
    if (mealsByPeriod.size === 0) return null;

    const slot = (period: HomeMealPeriod): HomeMealSlot => ({
        period,
        meal: mealsByPeriod.get(period) ?? null,
    });
    return [slot('중식'), slot('석식')];
}

export function mealPeriodLabel(meal: Pick<DashboardMealPost, 'title' | 'mealPeriod'>): string {
    return mealRecordPeriod(meal);
}

export function homeRecentMeals(snapshot: DashboardMealsSnapshot, reference: Date) {
    const unique = new Map(
        [...snapshot.data.dailyMenus, ...snapshot.data.recentMenus].map((meal) => [meal.id, meal]),
    );
    const previous = [...unique.values()].filter((meal) => {
        const date = mealServiceDate(meal, reference);
        return (
            date !== null &&
            date < kstDateKey(reference) &&
            ['중식', '석식'].includes(mealRecordPeriod(meal))
        );
    });
    const date = previous
        .map((meal) => mealServiceDate(meal, reference)!)
        .sort()
        .at(-1);
    return {
        date,
        meals: previous
            .filter((meal) => mealServiceDate(meal, reference) === date)
            .sort(
                (left, right) =>
                    (mealRecordPeriod(left) === '중식' ? 0 : 1) -
                    (mealRecordPeriod(right) === '중식' ? 0 : 1),
            ),
    };
}
