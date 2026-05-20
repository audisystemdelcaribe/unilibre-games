import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import {
    duplicateKeyUserMessage,
    isDuplicateKeyError,
    nextAnswerIds,
    nextTableId,
    syncQuestionsAnswersSequences,
} from '../../lib/syncSequences';
import { ensureAdmin, ensureQuestionManager } from '../utils';

type AnswerRow = {
    id: number;
    question_id: number;
    answer_text: string;
    is_correct: boolean;
};

async function persistAnswers(qId: number, rows: Omit<AnswerRow, 'id'>[], retried = false): Promise<void> {
    await supabaseAdmin.from('answers').delete().eq('question_id', qId);

    const ids = await nextAnswerIds(supabaseAdmin, rows.length);
    const payload: AnswerRow[] = rows.map((r, i) => ({
        id: ids[i],
        question_id: qId,
        answer_text: r.answer_text,
        is_correct: r.is_correct,
    }));

    const { error } = await supabaseAdmin.from('answers').insert(payload);
    if (!error) {
        void syncQuestionsAnswersSequences(supabaseAdmin);
        return;
    }

    if (isDuplicateKeyError(error) && !retried) {
        return persistAnswers(qId, rows, true);
    }

    if (isDuplicateKeyError(error)) {
        throw new Error(duplicateKeyUserMessage());
    }

    throw new Error(error.message);
}

async function insertQuestion(
    questionData: Record<string, unknown>,
    retried = false
): Promise<number> {
    const newId = await nextTableId(supabaseAdmin, 'questions');

    const { data, error } = await supabaseAdmin
        .from('questions')
        .insert([{ ...questionData, id: newId }])
        .select('id')
        .single();

    if (!error && data?.id) {
        void syncQuestionsAnswersSequences(supabaseAdmin);
        return data.id;
    }

    if (isDuplicateKeyError(error) && !retried) {
        return insertQuestion(questionData, true);
    }

    if (isDuplicateKeyError(error)) {
        throw new Error(duplicateKeyUserMessage());
    }

    throw new Error(error?.message ?? 'No se pudo crear la pregunta');
}

const returnQueryField = z.string().optional().default('');

export const questionsActions = {
    saveQuestion: defineAction({
        accept: 'form',
        input: z.object({
            id: z.string().optional(),
            subject_id: z.string(),
            level_id: z.string(),
            question_text: z.string().min(5),
            scope: z.string(),
            faculty_id: z.string().optional().nullable(),
            program_id: z.string().optional().nullable(),
            min_semester: z.string().default("1"),
            max_semester: z.string().default("10"),
            ans_1: z.string(), ans_2: z.string(), ans_3: z.string(), ans_4: z.string(),
            correct_idx: z.string(),
            return_query: returnQueryField,
        }),
        handler: async (input, context) => {
            await ensureQuestionManager(context);

            const { id, subject_id, level_id, question_text, scope, faculty_id, program_id, min_semester, max_semester, ans_1, ans_2, ans_3, ans_4, correct_idx, return_query } = input;

            let final_faculty = null;
            let final_program = null;

            if (scope === 'faculty') {
                if (!faculty_id?.trim()) throw new Error('Selecciona una facultad');
                final_faculty = parseInt(faculty_id, 10);
                if (isNaN(final_faculty)) throw new Error('Facultad inválida');
            } else if (scope === 'program') {
                if (!program_id?.trim()) throw new Error('Selecciona un programa');
                final_program = parseInt(program_id, 10);
                if (isNaN(final_program)) throw new Error('Programa inválido');
                if (faculty_id?.trim()) {
                    const f = parseInt(faculty_id, 10);
                    final_faculty = isNaN(f) ? null : f;
                }
            }

            if (!subject_id?.trim()) throw new Error('Selecciona una asignatura');
            const subjectId = parseInt(subject_id, 10);
            if (isNaN(subjectId)) throw new Error('Asignatura inválida');

            const questionData = {
                subject_id: subjectId,
                level_id: parseInt(level_id),
                question_text,
                scope,
                faculty_id: final_faculty,
                program_id: final_program,
                min_semester: parseInt(min_semester),
                max_semester: parseInt(max_semester),
            };

            const answerRows = [
                { question_id: 0, answer_text: ans_1, is_correct: correct_idx === "1" },
                { question_id: 0, answer_text: ans_2, is_correct: correct_idx === "2" },
                { question_id: 0, answer_text: ans_3, is_correct: correct_idx === "3" },
                { question_id: 0, answer_text: ans_4, is_correct: correct_idx === "4" },
            ];

            let qId: number;
            if (id && id !== "") {
                qId = parseInt(id, 10);
                if (isNaN(qId)) throw new Error('ID de pregunta inválido');
                const { error } = await supabaseAdmin.from('questions').update(questionData).eq('id', qId);
                if (error) throw new Error(error.message);
            } else {
                qId = await insertQuestion(questionData);
            }

            await persistAnswers(qId, answerRows);

            return { success: true, message: "Pregunta guardada exitosamente", return_query };
        }
    }),

    deleteQuestion: defineAction({
        accept: 'form',
        input: z.object({ id: z.string(), return_query: returnQueryField }),
        handler: async ({ id, return_query }, context) => {
            await ensureAdmin(context);
            const { error } = await supabaseAdmin.from('questions').delete().eq('id', parseInt(id));
            if (error) throw new Error(error.message);
            return { success: true, message: "Pregunta eliminada", return_query };
        }
    }),

    deleteQuestionsBulk: defineAction({
        accept: 'form',
        input: z.object({
            ids: z.string().min(1, "Selecciona al menos una pregunta"),
            return_query: returnQueryField,
        }),
        handler: async ({ ids, return_query }, context) => {
            await ensureAdmin(context);

            const idList = [
                ...new Set(
                    ids
                        .split(',')
                        .map((s) => parseInt(s.trim(), 10))
                        .filter((n) => !isNaN(n) && n > 0)
                ),
            ];

            if (idList.length === 0) {
                throw new Error("No hay preguntas válidas para eliminar");
            }
            if (idList.length > 200) {
                throw new Error("Máximo 200 preguntas por operación");
            }

            const { error } = await supabaseAdmin.from('questions').delete().in('id', idList);
            if (error) throw new Error(error.message);

            const n = idList.length;
            return {
                success: true,
                message: n === 1 ? "1 pregunta eliminada" : `${n} preguntas eliminadas`,
                return_query,
            };
        },
    }),
};
