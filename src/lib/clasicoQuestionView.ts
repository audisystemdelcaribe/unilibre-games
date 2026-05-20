import type { SupabaseClient } from "@supabase/supabase-js";
import { seededShuffle } from "./utils";

export type ClasicoAnswerOption = {
    id: number;
    answer_text: string;
    letter: string;
    is_correct: boolean;
};

export type ClasicoCurrentQuestion = {
    id: number;
    question_text: string;
    level_id: number | null;
    level_name: string | null;
    answers: ClasicoAnswerOption[];
};

/** Pregunta activa de Silla Caliente con opciones (mismo orden A–D que ve el estudiante). */
export async function loadClasicoCurrentQuestion(
    supabase: SupabaseClient,
    roundId: number,
    questionId: number
): Promise<ClasicoCurrentQuestion | null> {
    const { data: q, error } = await supabase
        .from("questions")
        .select("id, question_text, level_id, game_levels(name), answers(id, answer_text, is_correct)")
        .eq("id", questionId)
        .single();

    if (error || !q?.id) return null;

    const rawAnswers = (q.answers || []) as {
        id: number;
        answer_text: string;
        is_correct: boolean;
    }[];
    const shuffled = seededShuffle(rawAnswers, roundId * 31 + questionId);
    const letters = ["A", "B", "C", "D"];

    return {
        id: q.id,
        question_text: q.question_text,
        level_id: q.level_id ?? null,
        level_name: (q.game_levels as { name?: string } | null)?.name ?? null,
        answers: shuffled.map((a, i) => ({
            id: a.id,
            answer_text: a.answer_text,
            letter: letters[i] ?? String(i + 1),
            is_correct: !!a.is_correct,
        })),
    };
}
