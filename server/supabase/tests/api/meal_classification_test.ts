import { assertEquals } from "@std/assert";
import { classifyMeal } from "../../functions/_shared/meal-classification.ts";
const reference = Date.parse("2026-10-19T09:00:00+09:00");
Deno.test("Kakao headings distinguish weekly, lunch, dinner and pinned notices", () => {
  assertEquals(classifyMeal("10월 19일(월) 석식 메뉴", "중식과 관계없는 메뉴본문", false, reference), {
    category: "DAILY_MENU",
    mealPeriod: "DINNER",
    mealDate: "2026-10-19",
    kind: "DAILY_MENU",
  });
  assertEquals(classifyMeal("10월 3주차 식단표", "", true, reference).category, "WEEKLY_MENU");
  assertEquals(classifyMeal("굿즈 판매 공지", "10월 19일 중식 메뉴", true, reference).category, "OTHER");
  assertEquals(classifyMeal(null, "\n10월 19일 중식 메뉴\n밥, 국", false, reference).mealPeriod, "LUNCH");
  assertEquals(classifyMeal("중식 및 석식 메뉴 안내", "", false, reference).category, "OTHER");
  assertEquals(classifyMeal("중식 메뉴 / 석식 메뉴", "", false, reference).category, "OTHER");
});
Deno.test("meal dates require an explicit valid date and resolve the nearest year", () => {
  assertEquals(classifyMeal("석식 메뉴", "", false, reference).mealDate, null);
  assertEquals(classifyMeal("2월 30일 중식 메뉴", "", false, reference).mealDate, null);
  assertEquals(classifyMeal("2026년 2월 29일 중식 메뉴", "", false, reference).mealDate, null);
  assertEquals(classifyMeal("2024년 2월 29일 중식 메뉴", "", false, reference).mealDate, "2024-02-29");
  assertEquals(
    classifyMeal("1월 1일 석식 메뉴", "", false, Date.parse("2026-12-31T12:00:00Z")).mealDate,
    "2027-01-01",
  );
});
