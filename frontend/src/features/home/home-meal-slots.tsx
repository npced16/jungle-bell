import {MealPostCard, MissingMealPostCard} from '@/components/dashboard/meal-post-card';

import type {HomeMealSlots} from './home-view-model';

export function HomeMealSlotsList({slots}: {slots: HomeMealSlots | null}) {
    const visibleSlots: HomeMealSlots = slots ?? [{period: '중식', meal: null}, {period: '석식', meal: null}];
    return (
        <ul className="grid items-start gap-4 md:grid-cols-2" aria-label="오늘 중식과 석식">
            {visibleSlots.map(({period, meal}) => (
                <li
                    data-meal-empty={meal === null}
                    data-meal-period={period}
                    data-meal-state={meal ? 'published' : 'empty'}
                    className="min-w-0 space-y-3 text-foreground"
                    key={period}
                >
                    {meal ? <strong className="text-primary">{period}</strong> : null}
                    {meal ? (
                        <MealPostCard meal={meal} eagerImage hideImage={(meal.images?.length ?? 0) === 0} />
                    ) : (
                        <MissingMealPostCard period={period} blankImage />
                    )}
                </li>
            ))}
        </ul>
    );
}
