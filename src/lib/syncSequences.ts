import type { SupabaseClient } from "@supabase/supabase-js";

export function isDuplicateKeyError(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    if (error.code === "23505") return true;
    return /duplicate key/i.test(error.message ?? "");
}

/** Siguiente ID libre sin depender del panel de Supabase (MAX+1). */
export async function nextTableId(
    supabase: SupabaseClient,
    table: "questions" | "answers"
): Promise<number> {
    const { data, error } = await supabase
        .from(table)
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(error.message);
    return (data?.id ?? 0) + 1;
}

/** Bloque consecutivo de IDs para varias respuestas. */
export async function nextAnswerIds(supabase: SupabaseClient, count: number): Promise<number[]> {
    const start = await nextTableId(supabase, "answers");
    return Array.from({ length: count }, (_, i) => start + i);
}

/** Opcional: si existe la función RPC en la BD, alinea el contador automático. */
export async function syncQuestionsAnswersSequences(supabase: SupabaseClient): Promise<boolean> {
    const { error } = await supabase.rpc("sync_questions_answers_sequences");
    if (error) return false;
    return true;
}

export function duplicateKeyUserMessage(): string {
    return "No se pudo asignar un ID nuevo. Espera un momento y vuelve a guardar la pregunta.";
}
