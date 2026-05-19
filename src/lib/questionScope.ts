import type { PostgrestFilterBuilder } from '@supabase/supabase-js';

export type EventScope = { scope?: string; program_id?: number | null; faculty_id?: number | null };

export type QuestionScopeFields = {
    scope?: string | null;
    program_id?: number | null;
    faculty_id?: number | null;
};

export function normalizeEventScope(
    evt: EventScope | EventScope[] | null | undefined
): EventScope | null {
    if (!evt) return null;
    const ev = Array.isArray(evt) ? evt[0] : evt;
    if (!ev) return null;
    return {
        scope: ev.scope,
        program_id: ev.program_id != null ? Number(ev.program_id) : null,
        faculty_id: ev.faculty_id != null ? Number(ev.faculty_id) : null,
    };
}

/**
 * Comprueba si una pregunta pertenece al ámbito del evento.
 * Por defecto incluye preguntas globales (excepto en preselección con ámbito programa/facultad).
 */
export function questionMatchesEventScope(
    q: QuestionScopeFields,
    evt: EventScope | EventScope[] | null | undefined,
    options?: { includeGlobal?: boolean }
): boolean {
    const includeGlobal = options?.includeGlobal !== false;
    const ev = normalizeEventScope(evt);
    const qScope = q.scope || 'global';
    const qProgId = q.program_id != null ? Number(q.program_id) : null;
    const qFacId = q.faculty_id != null ? Number(q.faculty_id) : null;

    if (!ev) return qScope === 'global';

    const scope = ev.scope || 'global';

    if (scope === 'program' && ev.program_id != null) {
        if (qScope === 'program') return qProgId === Number(ev.program_id);
        if (qScope === 'global') return includeGlobal;
        return false;
    }

    if (scope === 'faculty' && ev.faculty_id != null) {
        if (qScope === 'faculty') return qFacId === Number(ev.faculty_id);
        if (qScope === 'global') return includeGlobal;
        return false;
    }

    return qScope === 'global';
}

export function filterQuestionsByEventScope<T extends QuestionScopeFields>(
    questions: T[],
    evt: EventScope | EventScope[] | null | undefined,
    options?: { includeGlobal?: boolean }
): T[] {
    return questions.filter((q) => questionMatchesEventScope(q, evt, options));
}

/**
 * Aplica filtro de programa/facultad/global a la consulta de preguntas.
 * Siempre incluye preguntas con scope='global' (salvo validación posterior en preselección).
 */
export function applyScopeFilter<T>(
    query: PostgrestFilterBuilder<T>,
    evt: EventScope | EventScope[] | null | undefined
): PostgrestFilterBuilder<T> {
    const ev = normalizeEventScope(evt);
    if (!ev) return query.eq('scope', 'global');
    const scope = ev.scope || 'global';
    if (scope === 'program' && ev.program_id != null) {
        return query.or(`and(scope.eq.program,program_id.eq.${ev.program_id}),scope.eq.global`);
    }
    if (scope === 'faculty' && ev.faculty_id != null) {
        return query.or(`and(scope.eq.faculty,faculty_id.eq.${ev.faculty_id}),scope.eq.global`);
    }
    return query.eq('scope', 'global');
}

/** Opciones de filtro para preselección: solo preguntas del programa/facultad del evento. */
export function scopeOptionsForGameMode(gameModeId: number | undefined): { includeGlobal: boolean } {
    if (gameModeId === 1) return { includeGlobal: false };
    return { includeGlobal: true };
}

/** Lanza error si la pregunta no corresponde al ámbito del evento. */
export function assertQuestionMatchesEventScope(
    q: QuestionScopeFields,
    evt: EventScope | EventScope[] | null | undefined,
    gameModeId: number | undefined
): void {
    if (!questionMatchesEventScope(q, evt, scopeOptionsForGameMode(gameModeId))) {
        throw new Error('La pregunta no pertenece al programa o ámbito de este evento.');
    }
}
