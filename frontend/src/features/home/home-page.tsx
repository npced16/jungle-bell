import type {DashboardLaundrySnapshot} from '@/api/dashboard-api';
import {Link} from '@tanstack/react-router';
import {ArrowRight, RefreshCw, Utensils, WashingMachine, type LucideIcon} from 'lucide-react';
import {type ReactNode, useEffect, useState} from 'react';

import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardFooter, CardHeader} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {useDashboardEnvironment} from '@/state/dashboard-context';
import {
    useRefreshHomeMutation,
    useSuspenseLaundryQuery,
    useSuspenseMealsQuery,
} from '@/state/use-dashboard-queries';

import {HomeMealSlotsList} from './home-meal-slots';
import {homeTodayMealSlots} from './home-view-model';
import {JungleCampusSummary} from './jungle-campus-summary';

function SummaryCard({
    icon: Icon,
    title,
    children,
    footer,
    className,
}: {
    icon: LucideIcon;
    title: string;
    children: ReactNode;
    footer: ReactNode;
    className?: string;
}) {
    return (
        <Card className={cn('min-h-60 gap-0 overflow-hidden py-0', className)}>
            <CardHeader className="min-h-16 shrink-0 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Icon aria-hidden="true" className="size-5" />
                    </span>
                    <h2 className="leading-none font-semibold">{title}</h2>
                </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 px-5 py-3 sm:px-6">
                {children}
            </CardContent>
            <CardFooter className="min-h-11 shrink-0 gap-2 border-t px-5 py-1.5 sm:px-6 [.border-t]:pt-1.5">
                {footer}
            </CardFooter>
        </Card>
    );
}

type LaundryGridRenderer = (snapshot: DashboardLaundrySnapshot, now: number) => ReactNode;

function HomeLaundrySummary({renderGrid}: {renderGrid?: LaundryGridRenderer}) {
    const now = useHomeClock();
    const laundry = useSuspenseLaundryQuery();
    const laundryRefreshFailed = laundry.isError;
    const laundryCollectorUnavailable = !laundry.data.quality.collectorHealthy;

    return (
        <SummaryCard
            icon={WashingMachine}
            title="세탁실"
            footer={
                <Button asChild size="sm" variant="link" className="px-0">
                    <Link to="/laundry">
                        기기별 현황 보기 <ArrowRight />
                    </Link>
                </Button>
            }
        >
            {laundryCollectorUnavailable ? (
                <p className="text-xs text-destructive">
                    수집 서버 장애로 마지막 확인 상태를 표시합니다.
                </p>
            ) : laundryRefreshFailed ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                    최신 상태를 가져오지 못해 마지막 확인 상태를 표시합니다.
                </p>
            ) : null}
            {renderGrid?.(laundry.data, now)}
        </SummaryCard>
    );
}

function HomeMealsSummary() {
    const now = useHomeClock();
    const meals = useSuspenseMealsQuery();
    const todayMealSlots = homeTodayMealSlots(meals.data, new Date(now));
    const mealsRefreshFailed = meals.isError;

    return (
        <SummaryCard
            icon={Utensils}
            title="오늘 급식"
            footer={
                <Button asChild size="sm" variant="link" className="px-0">
                    <Link to="/meals">
                        전체 급식 보기 <ArrowRight />
                    </Link>
                </Button>
            }
        >
            {mealsRefreshFailed ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                    최신 급식을 가져오지 못해 마지막 확인값을 표시합니다.
                </p>
            ) : null}
            <HomeMealSlotsList slots={todayMealSlots} />
        </SummaryCard>
    );
}

function useHomeClock() {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

function HomeLivingSummaries({renderGrid}: {renderGrid?: LaundryGridRenderer}) {
    return (
        <section className="grid gap-6" aria-label="오늘의 생활 정보">
            <AsyncBoundary
                errorTitle="세탁실 요약을 불러오지 못했습니다."
                errorDescription="급식 요약은 계속 확인할 수 있습니다. 세탁실 정보만 다시 시도해 주세요."
                fallback={<LoadingState label="세탁실 요약을 불러오는 중" />}
            >
                <HomeLaundrySummary renderGrid={renderGrid} />
            </AsyncBoundary>
            <AsyncBoundary
                errorTitle="급식 요약을 불러오지 못했습니다."
                errorDescription="세탁실 요약은 계속 확인할 수 있습니다. 급식 정보만 다시 시도해 주세요."
                fallback={<LoadingState label="급식 요약을 불러오는 중" />}
            >
                <HomeMealsSummary />
            </AsyncBoundary>
        </section>
    );
}

export function HomePage({renderLaundryGrid}: {renderLaundryGrid?: LaundryGridRenderer}) {
    const {platform} = useDashboardEnvironment();
    const refreshHome = useRefreshHomeMutation();
    const showAttendanceSummary = platform.kind === 'desktop';

    return (
        <div className="space-y-6">
            <PageHeader
                title="오늘 필요한 정보"
                actions={
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            disabled={refreshHome.isPending}
                            onClick={() => refreshHome.mutate()}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={refreshHome.isPending ? 'animate-spin' : ''}
                            />
                            {refreshHome.isPending ? '새로고침 중' : '새로고침'}
                        </Button>
                    </div>
                }
            />

            <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <strong className="font-medium text-foreground">임시 운영 중</strong>
                {' · '}현재 임시 운영 중입니다. 세탁실과 급식 정보를 웹에서 제공합니다.
            </p>

            <HomeLivingSummaries renderGrid={renderLaundryGrid} />

            {refreshHome.isError ? (
                <Alert variant="destructive">
                    <RefreshCw aria-hidden="true" />
                    <AlertTitle>전체 정보를 갱신하지 못했습니다.</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>갱신하지 못한 항목은 마지막으로 확인한 정보를 계속 표시합니다.</p>
                        <Button
                            disabled={refreshHome.isPending}
                            size="sm"
                            variant="outline"
                            onClick={() => refreshHome.mutate()}
                        >
                            새로고침
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}

            {showAttendanceSummary ? <JungleCampusSummary /> : null}
        </div>
    );
}

export default HomePage;
