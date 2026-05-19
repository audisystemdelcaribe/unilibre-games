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
};
