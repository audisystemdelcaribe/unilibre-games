import type { SupabaseClient } from "@supabase/supabase-js";

type GameLevelRow = {
    id: number;
    difficulty_order: number;
    money_value: number;
    is_safe_level: boolean;
    name?: string;
};

/**
 * Premio en pesos (Silla Caliente): último nivel seguro superado antes del nivel actual.
 * Misma regla que al fallar una pregunta.
 */
export async function computeClasicoSafePrize(
    supabase: SupabaseClient,
    roundId: number,
    playerId: number
): Promise<{ prizeMoney: number; currentLevelOrder: number; lastSafeLevelName: string | null }> {
    const { data: allLevels } = await supabase
        .from("game_levels")
        .select("id, difficulty_order, money_value, is_safe_level, name")
        .order("difficulty_order", { ascending: true });

    const levels = (allLevels || []) as GameLevelRow[];
    const currentOrder = await resolveCurrentLevelOrder(supabase, roundId, playerId, levels);

    const levelsPassed = levels.filter((l) => l.difficulty_order < currentOrder);
    const safeLevelsPassed = levelsPassed.filter((l) => l.is_safe_level);

    let prizeMoney = 0;
    let lastSafeLevelName: string | null = null;
    if (safeLevelsPassed.length > 0) {
        const lastSafe = safeLevelsPassed[safeLevelsPassed.length - 1];
        prizeMoney = lastSafe.money_value || 0;
        lastSafeLevelName = lastSafe.name || `Nivel ${lastSafe.difficulty_order}`;
    }

    return { prizeMoney, currentLevelOrder: currentOrder, lastSafeLevelName };
}

async function resolveCurrentLevelOrder(
    supabase: SupabaseClient,
    roundId: number,
    playerId: number,
    levels: GameLevelRow[]
): Promise<number> {
    const { data: round } = await supabase
        .from("event_rounds")
        .select("current_question_id, status")
        .eq("id", roundId)
        .single();

    if (round?.current_question_id) {
        const order = await levelOrderForQuestion(supabase, round.current_question_id, levels);
        if (order != null) return order;
    }

    const { data: lastCorrect } = await supabase
        .from("game_answers")
        .select("question_id")
        .eq("round_id", roundId)
        .eq("player_id", playerId)
        .eq("is_correct", true)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (lastCorrect?.question_id) {
        const passedOrder = await levelOrderForQuestion(supabase, lastCorrect.question_id, levels);
        if (passedOrder != null) {
            const next = levels.find((l) => l.difficulty_order === passedOrder + 1);
            return next?.difficulty_order ?? passedOrder + 1;
        }
    }

    return levels[0]?.difficulty_order ?? 1;
}

async function levelOrderForQuestion(
    supabase: SupabaseClient,
    questionId: number,
    levels: GameLevelRow[]
): Promise<number | null> {
    const { data: q } = await supabase.from("questions").select("level_id").eq("id", questionId).single();
    if (!q?.level_id) return null;
    const lvl = levels.find((l) => l.id === q.level_id);
    return lvl?.difficulty_order ?? null;
}
