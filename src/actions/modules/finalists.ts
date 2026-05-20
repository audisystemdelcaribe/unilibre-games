import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { ensureStaffFull } from '../utils';

export const finalistsActions = {
    removeFinalist: defineAction({
        accept: 'form',
        input: z.object({
            event_id: z.string(),
            player_id: z.string(),
            classroom_group_id: z.string().optional(),
            season_id: z.string().optional(),
            program_id: z.string().optional(),
        }),
        handler: async ({ event_id, player_id, classroom_group_id, season_id, program_id }, context) => {
            await ensureStaffFull(context);

            const eventId = parseInt(event_id, 10);
            const playerId = parseInt(player_id, 10);
            if (!Number.isFinite(eventId) || !Number.isFinite(playerId)) {
                throw new Error('Datos inválidos');
            }

            const { data: event } = await supabaseAdmin
                .from('events')
                .select('id, game_mode_id, season_id')
                .eq('id', eventId)
                .single();

            if (!event) throw new Error('Evento no encontrado');
            if (event.game_mode_id !== 1) {
                throw new Error('Solo se pueden quitar finalistas de eventos de Preselección');
            }

            let updateQuery = supabaseAdmin
                .from('event_players')
                .update({ is_finalist: false, final_rank: null })
                .eq('event_id', eventId)
                .eq('player_id', playerId)
                .eq('is_finalist', true);

            if (classroom_group_id != null && classroom_group_id !== '') {
                updateQuery = updateQuery.eq('classroom_group_id', classroom_group_id);
            }

            const { data: updated, error } = await updateQuery.select('player_id');

            if (error) throw new Error(error.message);
            if (!updated?.length) throw new Error('No se encontró ese finalista o ya fue eliminado');

            const params = new URLSearchParams();
            if (season_id) params.set('season_id', season_id);
            if (program_id) params.set('program_id', program_id);
            const qs = params.toString();

            return {
                success: true,
                message: 'Finalista eliminado correctamente',
                redirectTo: `/dashboard/finalistas${qs ? `?${qs}` : ''}`,
            };
        },
    }),

    /** Sustituir al ganador de preselección por otro participante del mismo evento/salón. */
    replaceFinalist: defineAction({
        accept: 'form',
        input: z.object({
            event_id: z.string(),
            outgoing_player_id: z.string(),
            incoming_player_id: z.string(),
            classroom_group_id: z.string().optional(),
            season_id: z.string().optional(),
            program_id: z.string().optional(),
        }),
        handler: async (
            { event_id, outgoing_player_id, incoming_player_id, classroom_group_id, season_id, program_id },
            context
        ) => {
            await ensureStaffFull(context);

            const eventId = parseInt(event_id, 10);
            const outgoingId = parseInt(outgoing_player_id, 10);
            const incomingId = parseInt(incoming_player_id, 10);
            if (!Number.isFinite(eventId) || !Number.isFinite(outgoingId) || !Number.isFinite(incomingId)) {
                throw new Error('Datos inválidos');
            }
            if (outgoingId === incomingId) {
                throw new Error('El nuevo ganador debe ser un participante distinto');
            }

            const { data: event } = await supabaseAdmin
                .from('events')
                .select('id, game_mode_id')
                .eq('id', eventId)
                .single();

            if (!event) throw new Error('Evento no encontrado');
            if (event.game_mode_id !== 1) {
                throw new Error('Solo se puede cambiar el ganador en eventos de Preselección');
            }

            const groupId = classroom_group_id ?? '';

            const applyGroup = <T extends { eq: (col: string, val: string) => T }>(q: T) =>
                groupId !== '' ? q.eq('classroom_group_id', groupId) : q;

            const { data: outgoing } = await applyGroup(
                supabaseAdmin
                    .from('event_players')
                    .select('player_id, is_finalist')
                    .eq('event_id', eventId)
                    .eq('player_id', outgoingId)
                    .eq('is_finalist', true)
            ).maybeSingle();

            if (!outgoing?.is_finalist) {
                throw new Error('El estudiante actual no está registrado como finalista en esta preselección');
            }

            const { data: incoming } = await applyGroup(
                supabaseAdmin
                    .from('event_players')
                    .select('player_id, is_finalist, players(name)')
                    .eq('event_id', eventId)
                    .eq('player_id', incomingId)
            ).maybeSingle();

            if (!incoming) {
                throw new Error('El nuevo ganador debe haber participado en esta misma preselección (mismo salón)');
            }
            if (incoming.is_finalist) {
                throw new Error('Ese estudiante ya es finalista en esta preselección');
            }

            const { error: demoteErr } = await applyGroup(
                supabaseAdmin
                    .from('event_players')
                    .update({ is_finalist: false, final_rank: null })
                    .eq('event_id', eventId)
                    .eq('player_id', outgoingId)
                    .eq('is_finalist', true)
            );
            if (demoteErr) throw new Error(demoteErr.message);

            const { error: promoteErr } = await applyGroup(
                supabaseAdmin
                    .from('event_players')
                    .update({ is_finalist: true, final_rank: 1 })
                    .eq('event_id', eventId)
                    .eq('player_id', incomingId)
            );
            if (promoteErr) throw new Error(promoteErr.message);

            const newName = (incoming.players as { name?: string } | null)?.name ?? 'el nuevo estudiante';
            const params = new URLSearchParams();
            if (season_id) params.set('season_id', season_id);
            if (program_id) params.set('program_id', program_id);
            const qs = params.toString();

            return {
                success: true,
                message: `Ganador actualizado: ahora ${newName} es finalista`,
                redirectTo: `/dashboard/finalistas${qs ? `?${qs}` : ''}`,
            };
        },
    }),
};
