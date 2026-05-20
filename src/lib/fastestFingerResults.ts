import type { SupabaseClient } from "@supabase/supabase-js";

export type FastestFingerAttemptRow = {
    player_id: number;
    name: string;
    response_time_ms: number;
    is_correct: boolean;
};

/** Intentos de una ronda de Mente más Rápida (nombres resueltos sin embed PostgREST). */
export async function loadFastestFingerAttempts(
    supabase: SupabaseClient,
    eventRoundId: number
): Promise<{ ffRoundId: number | null; attempts: FastestFingerAttemptRow[] }> {
    const { data: ffRound } = await supabase
        .from("fastest_finger_rounds")
        .select("id")
        .eq("event_round_id", eventRoundId)
        .maybeSingle();

    if (!ffRound?.id) {
        return { ffRoundId: null, attempts: [] };
    }

    const { data: rows, error } = await supabase
        .from("fastest_finger_attempts")
        .select("player_id, response_time_ms, is_correct")
        .eq("fastest_finger_round_id", ffRound.id);

    if (error || !rows?.length) {
        return { ffRoundId: ffRound.id, attempts: [] };
    }

    const playerIds = [...new Set(rows.map((r) => r.player_id).filter(Boolean))];
    const { data: players } = await supabase
        .from("players")
        .select("id, name")
        .in("id", playerIds);

    const nameMap = new Map((players || []).map((p) => [p.id, p.name || "Estudiante"]));

    const attempts: FastestFingerAttemptRow[] = rows.map((r) => ({
        player_id: r.player_id,
        name: nameMap.get(r.player_id) || "Estudiante",
        response_time_ms: r.response_time_ms ?? 0,
        is_correct: !!r.is_correct,
    }));

    return { ffRoundId: ffRound.id, attempts };
}

/** Ganador provisional: acierta en el menor tiempo. */
export function getProvisionalWinner(
    attempts: FastestFingerAttemptRow[]
): FastestFingerAttemptRow | null {
    const correct = attempts
        .filter((a) => a.is_correct)
        .sort((a, b) => a.response_time_ms - b.response_time_ms);
    return correct[0] ?? null;
}

export function formatFastestTimeMs(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return "—";
    return (ms / 1000).toFixed(2);
}
