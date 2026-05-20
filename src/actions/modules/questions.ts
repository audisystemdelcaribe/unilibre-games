import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { ensureAdmin, ensureQuestionManager } from '../utils';

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

            // Limpieza de IDs según el Scope para mantener la integridad de la DB
            let final_faculty = null;
            let final_program = null;

            if (scope === 'faculty') {
                final_faculty = parseInt(faculty_id!);
            } else if (scope === 'program') {
                final_program = parseInt(program_id!);
                final_faculty = faculty_id ? parseInt(faculty_id) : null;
            }

            const questionData = {
                subject_id: parseInt(subject_id),
                level_id: parseInt(level_id),
                question_text,
                scope,
                faculty_id: final_faculty,
                program_id: final_program,
                min_semester: parseInt(min_semester),
                max_semester: parseInt(max_semester)
            };

            let qId: number;
            if (id && id !== "") {
                qId = parseInt(id);
                const { error } = await supabaseAdmin.from('questions').update(questionData).eq('id', qId);
                if (error) throw new Error(error.message);
            } else {
                const { data, error } = await supabaseAdmin.from('questions').insert([questionData]).select().single();
                if (error) throw new Error(error.message);
                qId = data.id;
            }

            // Sincronizar Respuestas
            await supabaseAdmin.from('answers').delete().eq('question_id', qId);
            await supabaseAdmin.from('answers').insert([
                { question_id: qId, answer_text: ans_1, is_correct: correct_idx === "1" },
                { question_id: qId, answer_text: ans_2, is_correct: correct_idx === "2" },
                { question_id: qId, answer_text: ans_3, is_correct: correct_idx === "3" },
                { question_id: qId, answer_text: ans_4, is_correct: correct_idx === "4" },
            ]);

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