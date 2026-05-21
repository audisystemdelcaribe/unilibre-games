// src/actions/modules/fastest_finger.ts
import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { buildClasicoRoundMeta } from '../../lib/clasicoRoundContestant';
import {
    findClasicoEventForScope,
    resolveRoundEvent,
    setupClasicoWinner,
} from '../../lib/clasicoTransition';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { ensureAdmin, ensureStaffFull } from '../utils';

export const fastestFingerActions = {
    saveSequence: defineAction({
        accept: 'form',
        input: z.object({
            id: z.string().optional(),
            title: z.string().min(5, "Título muy corto"),
            // Recibimos la lista de ítems como un string JSON
            items_json: z.string().min(2, "Debes agregar al menos dos elementos"),
        }),
        handler: async (input, context) => {
            await ensureAdmin(context);

            const { id, title, items_json } = input;
            const itemsRaw = JSON.parse(items_json); // Formato esperado: string[]

            let seqId: number;

            // 1. Guardar/Actualizar Cabecera
            if (id && id.trim() !== "") {
                seqId = parseInt(id);
                await supabaseAdmin.from('fastest_finger_sequences').update({ title }).eq('id', seqId);
            } else {
                const { data, error } = await supabaseAdmin.from('fastest_finger_sequences').insert([{ title }]).select().single();
                if (error) throw new Error(error.message);
                seqId = data.id;
            }

            // 2. Guardar Items (Limpiar y Re-insertar)
            await supabaseAdmin.from('fastest_finger_items').delete().eq('sequence_id', seqId);

            const itemsToInsert = itemsRaw.map((text: string, index: number) => ({
                sequence_id: seqId,
                text: text,
                correct_position: index + 1 // La posición es el orden en el array
            }));

            const { error: itemsError } = await supabaseAdmin.from('fastest_finger_items').insert(itemsToInsert);
            if (itemsError) throw new Error(itemsError.message);

            return { success: true, message: "Secuencia dinámica guardada" };
        }
    }),
    deleteSequence: defineAction({
        accept: 'form',
        input: z.object({ id: z.string() }),
        handler: async ({ id }, context) => {
            await ensureAdmin(context);
            const { error } = await supabaseAdmin.from('fastest_finger_sequences').delete().eq('id', parseInt(id));
            if (error) throw new Error(error.message);
            return { success: true, message: "Secuencia eliminada" };
        }
    }),

    launchFastestFinger: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            await ensureStaffFull(context); // Mente más Rápida: preseleccion no puede
            const rId = parseInt(round_id);

            const { data: round } = await supabaseAdmin.from('event_rounds').select('event_id, classroom_group_id, status').eq('id', rId).single();
            if (!round) throw new Error("Ronda no encontrada");

            // Si venimos de waiting (sin preselección): marcar a todos los participantes como finalistas
            if (round.status === 'waiting') {
                const { data: participants } = await supabaseAdmin
                    .from('event_players')
                    .select('player_id')
                    .eq('event_id', round.event_id)
                    .eq('classroom_group_id', round.classroom_group_id ?? '');
                if (participants?.length) {
                    for (const p of participants) {
                        await supabaseAdmin.from('event_players').update({ is_finalist: true })
                            .eq('event_id', round.event_id).eq('player_id', p.player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                    }
                }
            }

            const { data: allSeqs } = await supabaseAdmin.from('fastest_finger_sequences').select('id');
            if (!allSeqs?.length) throw new Error("No hay retos configurados. Crea al menos uno en Mente más Rápida.");
            const seqId = allSeqs[Math.floor(Math.random() * allSeqs.length)].id;

            const { data: existing } = await supabaseAdmin
                .from('fastest_finger_rounds')
                .select('id')
                .eq('event_round_id', rId)
                .maybeSingle();

            let ffRound: { id?: number } | null;
            if (existing) {
                const { data, error } = await supabaseAdmin
                    .from('fastest_finger_rounds')
                    .update({ sequence_id: seqId, started_at: new Date().toISOString() })
                    .eq('event_round_id', rId)
                    .select()
                    .single();
                if (error) throw new Error(error.message);
                ffRound = data;
            } else {
                const { data, error } = await supabaseAdmin
                    .from('fastest_finger_rounds')
                    .insert({ event_round_id: rId, sequence_id: seqId })
                    .select()
                    .single();
                if (error) throw new Error(error.message);
                ffRound = data;
            }

            await supabaseAdmin.from('event_rounds').update({
                status: 'fastest_finger',
                question_started_at: new Date().toISOString()
            }).eq('id', rId);

            return { success: true, message: "Reto Mente más Rápida activado", ff_round_id: ffRound?.id };
        }
    }),

    submitFastestFingerAttempt: defineAction({
        accept: 'form',
        input: z.object({
            ff_round_id: z.string(),
            selected_order: z.string(),
            response_time_ms: z.string()
        }),
        handler: async (input, context) => {
            const user = await context.locals.getUser();
            if (!user) throw new Error("Debes iniciar sesión");

            const ffRoundId = parseInt(input.ff_round_id);
            const responseTimeMs = parseInt(input.response_time_ms);
            let selectedOrder: number[];
            try {
                selectedOrder = JSON.parse(input.selected_order) as number[];
            } catch {
                throw new Error("Orden inválido");
            }

            const { data: player } = await supabaseAdmin.from('players').select('id').eq('auth_user_id', user.id).single();
            if (!player?.id) throw new Error("Jugador no encontrado");

            const { data: ffRound } = await supabaseAdmin
                .from('fastest_finger_rounds')
                .select('*, event_rounds(event_id)')
                .eq('id', ffRoundId)
                .single();

            if (!ffRound) throw new Error("Reto no encontrado");

            const { data: items } = await supabaseAdmin
                .from('fastest_finger_items')
                .select('id, correct_position')
                .eq('sequence_id', ffRound.sequence_id)
                .order('correct_position');

            const correctOrder = (items || []).map((i: { id: number }) => i.id);
            const isCorrect = selectedOrder.length === correctOrder.length &&
                selectedOrder.every((id, idx) => id === correctOrder[idx]);

            const { data: existingAttempt } = await supabaseAdmin
                .from('fastest_finger_attempts')
                .select('id')
                .eq('fastest_finger_round_id', ffRoundId)
                .eq('player_id', player.id)
                .maybeSingle();

            if (existingAttempt) {
                const { error } = await supabaseAdmin
                    .from('fastest_finger_attempts')
                    .update({ selected_order: selectedOrder, response_time_ms: responseTimeMs, is_correct: isCorrect })
                    .eq('fastest_finger_round_id', ffRoundId)
                    .eq('player_id', player.id);
                if (error) throw new Error(error.message);
            } else {
                const { error } = await supabaseAdmin
                    .from('fastest_finger_attempts')
                    .insert({
                        fastest_finger_round_id: ffRoundId,
                        player_id: player.id,
                        selected_order: selectedOrder,
                        response_time_ms: responseTimeMs,
                        is_correct: isCorrect
                    });
                if (error) throw new Error(error.message);
            }
            return { success: true, correct: isCorrect, time: (responseTimeMs / 1000).toFixed(2) };
        }
    }),

    confirmWinner: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string(), player_id: z.string() }),
        handler: async ({ round_id, player_id }, context) => {
            await ensureStaffFull(context); // Mente más Rápida: preseleccion no puede

            const rId = parseInt(round_id);
            const pId = parseInt(player_id);

            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('event_id, events(season_id, program_id, faculty_id, scope)')
                .eq('id', rId)
                .single();
            if (!round) throw new Error("Ronda no encontrada");

            const evt = resolveRoundEvent(round.events);
            if (!evt?.season_id) throw new Error("No se pudo obtener la temporada del evento");

            const clasicoEvent = await findClasicoEventForScope(supabaseAdmin, evt);

            if (!clasicoEvent) {
                const scopeHint = evt?.scope === 'program' ? ' y mismo programa' : evt?.scope === 'faculty' ? ' y misma facultad' : '';
                throw new Error(`No hay evento Clásico (Silla Caliente) para esta temporada${scopeHint}. Crea uno en Eventos con modo Clásico.`);
            }

            // Crear ronda para Silla Caliente (como openClassroomSession)
            const session_pin = Math.floor(1000 + Math.random() * 9000).toString();
            const { data: clasicoRound, error: roundErr } = await supabaseAdmin
                .from('event_rounds')
                .insert([{
                    event_id: clasicoEvent.id,
                    round_number: 0,
                    type: 'classroom_quiz',
                    status: 'waiting',
                    classroom_group_id: 'Silla Caliente',
                    session_pin,
                    verification_result: buildClasicoRoundMeta(pId, rId),
                }])
                .select()
                .single();

            if (roundErr) throw new Error(roundErr.message);

            await setupClasicoWinner(supabaseAdmin, {
                playerId: pId,
                clasicoEventId: clasicoEvent.id,
                clasicoRoundId: clasicoRound.id,
            });

            // Finalizar ronda de Mente más Rápida
            await supabaseAdmin.from('event_rounds').update({ status: 'finished' }).eq('id', rId);

            return {
                success: true,
                message: "Ganador confirmado. El concursante puede entrar en /play/silla-caliente o con el PIN mostrado.",
                clasico_round_id: clasicoRound.id,
                clasico_pin: session_pin
            };
        }
    })
};