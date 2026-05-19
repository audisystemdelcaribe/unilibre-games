import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { markQuestionShown } from '../../lib/gameAnswer';
import { applyScopeFilter, filterQuestionsByEventScope, type EventScope } from '../../lib/questionScope';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { ensureAdmin, ensureStaffFull } from '../utils';

export const lifelinesActions = {
    useLifeline5050: defineAction({
        accept: 'form',
        input: z.object({
            round_id: z.string(),
            question_id: z.string(),
        }),
        handler: async (input, context) => {
            await ensureStaffFull(context); // Comodines son para Clásico

            const { round_id, question_id } = input;
            const rId = parseInt(round_id);
            const qId = parseInt(question_id);

            const { data: alreadyUsed } = await supabaseAdmin
                .from('round_lifeline_usage')
                .select('id')
                .eq('round_id', rId)
                .eq('lifeline_code', '5050')
                .limit(1)
                .maybeSingle();
            if (alreadyUsed) throw new Error("El comodín 50:50 ya fue usado en esta sesión.");

            const { data: answers } = await supabaseAdmin
                .from('answers')
                .select('id, is_correct')
                .eq('question_id', qId);

            if (!answers || answers.length < 3) {
                throw new Error("Pregunta no válida para 50:50");
            }

            const incorrect = answers.filter((a) => !a.is_correct);
            if (incorrect.length < 2) {
                throw new Error("No hay suficientes opciones incorrectas");
            }

            const shuffled = [...incorrect].sort(() => Math.random() - 0.5);
            const hideIds = shuffled.slice(0, 2).map((a) => a.id);

            const { error } = await supabaseAdmin.from('round_lifeline_usage').upsert({
                round_id: rId,
                question_id: qId,
                lifeline_code: '5050',
                metadata: { hide_ids: hideIds },
            }, { onConflict: 'round_id,question_id,lifeline_code' });

            if (error) throw new Error(error.message);
            return { success: true, hide_ids: hideIds };
        }
    }),

    saveLifeline: defineAction({
        accept: 'form',
        input: z.object({
            id: z.string().optional(),
            name: z.string().min(2, "El nombre es obligatorio"),
            description: z.string().optional(),
            code: z.string().optional(),
        }),
        handler: async (input, context) => {
            await ensureAdmin(context);

            const { id, name, description, code } = input;
            const data = { name, description, code: code || null };

            if (id && id.trim() !== "") {
                const { error } = await supabaseAdmin.from('lifelines').update(data).eq('id', parseInt(id));
                if (error) throw new Error(error.message);
                return { success: true, message: "Comodín actualizado correctamente" };
            } else {
                const { error } = await supabaseAdmin.from('lifelines').insert([data]);
                if (error) throw new Error(error.message);
                return { success: true, message: "Nuevo comodín creado" };
            }
        }
    }),

    deleteLifeline: defineAction({
        accept: 'form',
        input: z.object({ id: z.string() }),
        handler: async ({ id }, context) => {
            await ensureAdmin(context);
            const { error } = await supabaseAdmin.from('lifelines').delete().eq('id', parseInt(id));
            if (error) throw new Error(error.message);
            return { success: true, message: "Comodín eliminado" };
        }
    }),

    useLifelineCambiarPregunta: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string(), question_id: z.string() }),
        handler: async ({ round_id, question_id }, context) => {
            await ensureStaffFull(context); // Comodines son para Clásico
            const rId = parseInt(round_id);
            const qId = parseInt(question_id);

            const { data: currentQ } = await supabaseAdmin.from('questions').select('level_id').eq('id', qId).single();
            if (!currentQ?.level_id) throw new Error("Pregunta no encontrada");

            const { data: round } = await supabaseAdmin.from('event_rounds').select('event_id, events(scope, program_id, faculty_id, game_mode_id)').eq('id', rId).single();
            if (!round) throw new Error("Ronda no encontrada");

            const { data: cambiarUsed } = await supabaseAdmin
                .from('round_lifeline_usage')
                .select('id')
                .eq('round_id', rId)
                .eq('lifeline_code', 'cambiar')
                .limit(1)
                .maybeSingle();
            if (cambiarUsed) throw new Error("El comodín Cambiar pregunta ya fue usado en esta sesión.");

            let usedIds: number[] = [];
            const { data: shown } = await supabaseAdmin.from('round_questions_shown').select('question_id').eq('round_id', rId);
            if (shown?.length) usedIds = shown.map((s: { question_id: number }) => s.question_id).filter(Boolean);
            usedIds.push(qId);

            // Silla Caliente: filtrar por semestre del concursante activo
            let playerSemester: number | null = null;
            const gameModeId = (round.events as { game_mode_id?: number })?.game_mode_id;
            if (gameModeId === 2) {
                const { data: ac } = await supabaseAdmin.from('active_contestants').select('player_id').eq('event_id', round.event_id).maybeSingle();
                if (ac?.player_id) {
                    const { data: pl } = await supabaseAdmin.from('players').select('semester').eq('id', ac.player_id).single();
                    if (pl?.semester != null) playerSemester = pl.semester;
                }
            }

            let query = supabaseAdmin.from('questions').select('id, scope, program_id, faculty_id').eq('level_id', currentQ.level_id).eq('active', true);
            query = applyScopeFilter(query, round.events as EventScope);
            if (playerSemester != null) query = query.lte('min_semester', playerSemester).gte('max_semester', playerSemester);
            const { data: available } = await query;
            const scoped = filterQuestionsByEventScope(available || [], round.events as EventScope);
            const availableIds = scoped.map((q) => q.id).filter((id: number) => !usedIds.includes(id));

            if (availableIds.length === 0) throw new Error("No hay más preguntas de este nivel disponibles.");

            const chosenId = availableIds[Math.floor(Math.random() * availableIds.length)];
            await markQuestionShown(rId, chosenId);
            await supabaseAdmin.from('event_rounds').update({
                current_question_id: chosenId,
                question_started_at: new Date().toISOString(),
            }).eq('id', rId);

            await supabaseAdmin.from('round_lifeline_usage').upsert({
                round_id: rId,
                question_id: qId,
                lifeline_code: 'cambiar',
                metadata: { replaced_with: chosenId },
            }, { onConflict: 'round_id,question_id,lifeline_code' });

            return { success: true, message: "Pregunta cambiada" };
        }
    }),

    useLifelineLlamada: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string(), question_id: z.string() }),
        handler: async ({ round_id, question_id }, context) => {
            await ensureStaffFull(context); // Comodines son para Clásico
            const rId = parseInt(round_id);

            const { data: alreadyUsed } = await supabaseAdmin
                .from('round_lifeline_usage')
                .select('id')
                .eq('round_id', rId)
                .eq('lifeline_code', 'llamada')
                .limit(1)
                .maybeSingle();
            if (alreadyUsed) throw new Error("El comodín Llamada ya fue usado en esta sesión.");

            const qId = parseInt(question_id);
            const { error } = await supabaseAdmin.from('round_lifeline_usage').upsert({
                round_id: rId,
                question_id: qId,
                lifeline_code: 'llamada',
                metadata: { used: true },
            }, { onConflict: 'round_id,question_id,lifeline_code' });

            if (error) throw new Error(error.message);
            return { success: true, message: "Comodín Llamada a docente usado" };
        }
    }),

    useLifelinePublico: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string(), question_id: z.string() }),
        handler: async ({ round_id, question_id }, context) => {
            await ensureStaffFull(context); // Comodines son para Clásico
            const rId = parseInt(round_id);

            const { data: alreadyUsed } = await supabaseAdmin
                .from('round_lifeline_usage')
                .select('id')
                .eq('round_id', rId)
                .eq('lifeline_code', 'publico')
                .limit(1)
                .maybeSingle();
            if (alreadyUsed) throw new Error("El comodín Ayuda del público ya fue usado en esta sesión.");

            const qId = parseInt(question_id);
            const { error } = await supabaseAdmin.from('round_lifeline_usage').upsert({
                round_id: rId,
                question_id: qId,
                lifeline_code: 'publico',
                metadata: { used: true },
            }, { onConflict: 'round_id,question_id,lifeline_code' });

            if (error) throw new Error(error.message);
            return { success: true, message: "Comodín Ayuda del público activado" };
        }
    }),

    useLastWord: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string(), question_id: z.string() }),
        handler: async ({ round_id, question_id }, context) => {
            await ensureStaffFull(context); // Comodines son para Clásico
            const rId = parseInt(round_id);
            const qId = parseInt(question_id);

            const { error } = await supabaseAdmin.from('round_lifeline_usage').upsert({
                round_id: rId,
                question_id: qId,
                lifeline_code: 'last_word',
                metadata: { used: true },
            }, { onConflict: 'round_id,question_id,lifeline_code' });

            if (error) throw new Error(error.message);
            return { success: true, message: "Última palabra activada. El estudiante no puede cambiar su respuesta." };
        }
    })
};