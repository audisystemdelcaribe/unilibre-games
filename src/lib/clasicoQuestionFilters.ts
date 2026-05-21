import type { PostgrestFilterBuilder } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuestionScopeFields } from "./questionScope";

export type ContestantProfile = {
    player_id: number;
    semester: number | null;
    program_id: number | null;
    faculty_id: number | null;
};

/** Concursante activo de Silla Caliente con programa y facultad (vía programs). */
export async function loadClasicoContestant(
    supabase: SupabaseClient,
    eventId: number
): Promise<ContestantProfile | null> {
    const { data: ac } = await supabase
        .from("active_contestants")
        .select("player_id")
        .eq("event_id", eventId)
        .maybeSingle();

    if (!ac?.player_id) return null;
    return loadContestantByPlayerId(supabase, ac.player_id);
}

/**
 * La pregunta aplica si el semestre del estudiante está dentro del rango [min_semester, max_semester].
 * Ej.: pregunta 1–10 sí aplica a un estudiante de semestre 1; pregunta 5–8 no.
 */
export function questionMatchesClasicoSemester(
    q: { min_semester?: number | null; max_semester?: number | null },
    playerSemester: number | null
): boolean {
    if (playerSemester == null) return true;
    const minS = q.min_semester ?? 1;
    const maxS = q.max_semester ?? 12;
    return minS <= playerSemester && maxS >= playerSemester;
}

export function applyClasicoSemesterFilter<T>(
    query: PostgrestFilterBuilder<T>,
    playerSemester: number | null
): PostgrestFilterBuilder<T> {
    if (playerSemester == null) return query;
    return query.lte("min_semester", playerSemester).gte("max_semester", playerSemester);
}

/** Filtro SQL: preguntas del programa, facultad o globales del concursante. */
export function applyContestantScopeFilter<T>(
    query: PostgrestFilterBuilder<T>,
    contestant: ContestantProfile
): PostgrestFilterBuilder<T> {
    const parts: string[] = ["scope.eq.global"];
    if (contestant.program_id != null) {
        parts.push(`and(scope.eq.program,program_id.eq.${contestant.program_id})`);
    }
    if (contestant.faculty_id != null) {
        parts.push(`and(scope.eq.faculty,faculty_id.eq.${contestant.faculty_id})`);
    }
    return query.or(parts.join(","));
}

/** Refuerzo en JS: pregunta del programa o facultad del participante. */
export function questionMatchesContestantScope(
    q: QuestionScopeFields,
    contestant: ContestantProfile
): boolean {
    const qScope = q.scope || "global";
    const qProg = q.program_id != null ? Number(q.program_id) : null;
    const qFac = q.faculty_id != null ? Number(q.faculty_id) : null;

    if (qScope === "global") return true;
    if (contestant.program_id != null && qScope === "program") {
        return qProg === Number(contestant.program_id);
    }
    if (contestant.faculty_id != null && qScope === "faculty") {
        return qFac === Number(contestant.faculty_id);
    }
    return false;
}

export function filterQuestionsForContestant<T extends QuestionScopeFields>(
    questions: T[],
    contestant: ContestantProfile
): T[] {
    return questions.filter((q) => questionMatchesContestantScope(q, contestant));
}

export async function loadContestantByPlayerId(
    supabase: SupabaseClient,
    playerId: number
): Promise<ContestantProfile | null> {
    const { data: pl } = await supabase
        .from("players")
        .select("id, semester, program_id, programs(faculty_id)")
        .eq("id", playerId)
        .single();

    if (!pl) return null;

    const prog = pl.programs as { faculty_id?: number | null } | null;

    return {
        player_id: pl.id,
        semester: pl.semester ?? null,
        program_id: pl.program_id ?? null,
        faculty_id: prog?.faculty_id ?? null,
    };
}

/** IDs de preguntas disponibles para Silla Caliente (nivel, ámbito y semestre del participante). */
export async function fetchClasicoQuestionIds(
    supabase: SupabaseClient,
    contestant: ContestantProfile,
    levelId: number,
    usedIds: number[]
): Promise<number[]> {
    let query = supabase
        .from("questions")
        .select("id, scope, program_id, faculty_id, min_semester, max_semester")
        .eq("level_id", levelId)
        .eq("active", true);

    query = applyContestantScopeFilter(query, contestant);
    query = applyClasicoSemesterFilter(query, contestant.semester);

    const { data: rows } = await query;
    const scoped = filterQuestionsForContestant(rows || [], contestant).filter((q) =>
        questionMatchesClasicoSemester(q, contestant.semester)
    );
    return scoped.map((q) => q.id).filter((id) => !usedIds.includes(id));
}
