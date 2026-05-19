import { supabaseAdmin } from './supabaseAdmin';

export type SaveGameAnswerParams = {
    gameSessionId: number;
    roundId: number;
    eventId: number;
    playerId: number;
    classroomGroupId: string;
    questionId: number;
    answerId: number;
    isCorrect: boolean;
    responseTimeMs: number;
    moneyAtQuestion: number;
    levelId: number;
};

export type SaveGameAnswerResult = {
    insertId: number | null;
    alreadyAnswered: boolean;
    isCorrect: boolean;
    points: number;
};

export function isDuplicateDbError(err: { message?: string; code?: string } | null): boolean {
    if (!err) return false;
    if (err.code === '23505') return true;
    return /duplicate key|unique constraint|already exists|violates unique/i.test(err.message ?? '');
}

/**
 * Guarda una respuesta de forma idempotente (una por sesión + pregunta).
 * Evita error "duplicate key" por doble clic o peticiones simultáneas.
 */
export async function saveGameAnswerIdempotent(params: SaveGameAnswerParams): Promise<SaveGameAnswerResult> {
    const { gameSessionId, questionId } = params;

    const { data: existing } = await supabaseAdmin
        .from('game_answers')
        .select('id, is_correct, money_at_question')
        .eq('game_session_id', gameSessionId)
        .eq('question_id', questionId)
        .maybeSingle();

    if (existing) {
        return {
            insertId: existing.id,
            alreadyAnswered: true,
            isCorrect: existing.is_correct ?? false,
            points: existing.money_at_question ?? 0,
        };
    }

    const { data: insertedId, error: insertErr } = await supabaseAdmin.rpc('insert_game_answer', {
        p_game_session_id: params.gameSessionId,
        p_round_id: params.roundId,
        p_event_id: params.eventId,
        p_player_id: params.playerId,
        p_classroom_group_id: params.classroomGroupId,
        p_question_id: params.questionId,
        p_answer_id: params.answerId,
        p_is_correct: params.isCorrect,
        p_response_time_ms: params.responseTimeMs,
        p_money_at_question: params.moneyAtQuestion,
        p_level_id: params.levelId,
    });

    if (!insertErr && insertedId != null) {
        return {
            insertId: typeof insertedId === 'number' ? insertedId : Number(insertedId),
            alreadyAnswered: false,
            isCorrect: params.isCorrect,
            points: params.moneyAtQuestion,
        };
    }

    if (isDuplicateDbError(insertErr)) {
        const { data: recovered } = await supabaseAdmin
            .from('game_answers')
            .select('id, is_correct, money_at_question')
            .eq('game_session_id', gameSessionId)
            .eq('question_id', questionId)
            .maybeSingle();

        if (recovered) {
            return {
                insertId: recovered.id,
                alreadyAnswered: true,
                isCorrect: recovered.is_correct ?? false,
                points: recovered.money_at_question ?? 0,
            };
        }
    }

    throw new Error(insertErr?.message ?? 'Error al guardar respuesta');
}

/** Registra pregunta mostrada sin fallar si ya existe (round_id + question_id). */
export async function markQuestionShown(roundId: number, questionId: number): Promise<void> {
    const { error } = await supabaseAdmin
        .from('round_questions_shown')
        .upsert({ round_id: roundId, question_id: questionId }, { onConflict: 'round_id,question_id', ignoreDuplicates: true });
    if (error && !isDuplicateDbError(error)) {
        console.warn('[markQuestionShown]', error.message);
    }
}
