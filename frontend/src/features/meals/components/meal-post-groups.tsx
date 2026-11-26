import type {DashboardMealsSnapshot} from '@/api/dashboard-api';

import {groupMealPosts} from '../lib/meal-classification';
import {MealPostCard} from './meal-post-card';

export function MealPostGroups({meals}: {meals: DashboardMealsSnapshot}) {
    const groups = groupMealPosts(meals.data);
    return (
        <section aria-labelledby="meal-posts-title" className="space-y-5">
            <div>
                <h2 id="meal-posts-title" className="font-semibold">
                    카카오채널 게시물
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    저장된 사진과 원문입니다. 날짜가 확인되지 않은 게시물도 함께 표시합니다.
                </p>
            </div>
            {[...groups].map(([label, posts], index) => (
                <section key={label} aria-labelledby={`meal-post-group-${index}`}>
                    <h3 id={`meal-post-group-${index}`} className="mb-3 font-medium">
                        {label} <span className="text-muted-foreground">{posts.length}건</span>
                    </h3>
                    {posts.length ? (
                        <div className="grid items-start gap-4 md:grid-cols-2">
                            {posts.map((post) => (
                                <MealPostCard compact key={post.id} meal={post} />
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">저장된 게시물이 없습니다.</p>
                    )}
                </section>
            ))}
        </section>
    );
}
