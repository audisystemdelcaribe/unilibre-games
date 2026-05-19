// src/actions/modules/live_sessions.ts
import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import {
    applyScopeFilter,
    assertQuestionMatchesEventScope,
    filterQuestionsByEventScope,
    normalizeEventScope,
    questionMatchesEventScope,
    scopeOptionsForGameMode,
    type EventScope,
} from '../../lib/questionScope';
import { saveGameAnswerIdempotent, markQuestionShown } from '../../lib/gameAnswer';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import { ensureStaff, ensureStaffFull } from '../utils';

export const liveSessionsActions = {
    openClassroomSession: defineAction({
        accept: 'form',
        input: z.object({
            event_id: z.string(),
            classroom_group_id: z.string().optional(),
        }),
        handler: async (input, context) => {
            await ensureStaff(context);

            const { event_id, classroom_group_id } = input;
            const { data: evt } = await supabaseAdmin.from('events').select('game_mode_id').eq('id', parseInt(event_id)).single();
            const gm = evt?.game_mode_id;

            // Rol preseleccion: solo puede abrir sesiones de Preselección (game_mode_id = 1)
            const user = await context.locals.getUser();
            const { data: myProfile } = await context.locals.supabase.from('players').select('role').eq('auth_user_id', user?.id).single();
            if (myProfile?.role === 'preseleccion' && gm !== 1) {
                throw new Error("Tu rol solo permite realizar Preselección. No puedes abrir Mente más Rápida ni Silla Caliente.");
            }
            const groupId = gm === 3 ? 'Gran Final' : gm === 2 ? 'Silla Caliente' : (classroom_group_id?.trim() || '');
            if (!groupId || groupId.length < 2) throw new Error("El nombre del grupo es obligatorio");

            // 1. Generar un PIN aleatorio de 4 o 6 números
            // Verificamos que no exista uno igual activo (opcional pero recomendado)
            const session_pin = Math.floor(1000 + Math.random() * 9000).toString();

            // 2. Crear la fila en event_rounds que actuará como "Sala de espera"
            const { data: round, error } = await supabaseAdmin
                .from('event_rounds')
                .insert([{
                    event_id: parseInt(event_id),
                    round_number: 0, // Ronda 0 significa "Lobby / Sala de espera"
                    type: 'classroom_quiz',
                    status: 'waiting',
                    classroom_group_id: groupId,
                    session_pin: session_pin
                }])
                .select()
                .single();

            if (error) throw new Error(error.message);

            return {
                success: true,
                message: "¡Salón abierto con éxito!",
                pin: session_pin,
                round_id: round.id
            };
        }
    }),
    startGame: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            await ensureStaff(context);

            // 1. Cambiamos el estado a 'active'
            // 2. Opcional: Aquí podrías elegir la primera pregunta aleatoria
            const { error } = await supabaseAdmin
                .from('event_rounds')
                .update({ status: 'active', round_number: 1 })
                .eq('id', parseInt(round_id));

            if (error) throw new Error(error.message);
            return { success: true };
        }
    }),
    joinRoom: defineAction({
        accept: 'form',
        input: z.object({ pin: z.string(), as_audience: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional() }),
        handler: async ({ pin, as_audience }, context) => {
            const user = await context.locals.getUser();
            if (!user) throw new Error("Debes iniciar sesión");

            // 1. Buscar la ronda por PIN (con evento y modo de juego)
            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('*, events(game_mode_id, season_id, program_id, faculty_id, scope)')
                .eq('session_pin', pin)
                .single();

            if (!round) throw new Error("PIN no válido");

            // 2. Buscar ID del jugador
            const { data: player } = await supabaseAdmin
                .from('players')
                .select('id')
                .eq('auth_user_id', user.id)
                .single();

            if (!player?.id) throw new Error("Perfil de jugador no encontrado");

            const gameModeId = (round.events as { game_mode_id?: number })?.game_mode_id;
            const roundStatus = (round as { status?: string })?.status;
            const evt = round.events as {
                game_mode_id?: number;
                season_id?: number;
                program_id?: number | null;
                faculty_id?: number | null;
                scope?: string;
            };

            // Preselección por programa: solo estudiantes de ese programa (evita mezcla de salones)
            if (gameModeId === 1 && evt?.scope === 'program' && evt.program_id != null) {
                const { data: pl } = await supabaseAdmin
                    .from('players')
                    .select('program_id, programs(name)')
                    .eq('id', player.id)
                    .single();
                if (pl?.program_id == null) {
                    throw new Error('Actualiza tu programa en Mi cuenta antes de participar.');
                }
                if (Number(pl.program_id) !== Number(evt.program_id)) {
                    const progName = (pl.programs as { name?: string } | null)?.name;
                    throw new Error(
                        progName
                            ? `Este salón es solo para el programa del evento. Tu perfil está en «${progName}».`
                            : 'Este salón es solo para estudiantes del programa del evento.'
                    );
                }
            }

            // 2a. "Ayudar a participante": siempre ir como público
            if (as_audience) return { success: true, round_id: round.id, audience_only: true };

            // 2b. Mente más Rápida: solo finalistas del evento Preselección (game_mode 1) misma temporada/ámbito
            if (gameModeId === 3 || roundStatus === 'fastest_finger') {
                const { isFinalistInPreseleccion } = await import('../../lib/preseleccionFinalist');
                const isFinalist = await isFinalistInPreseleccion(supabaseAdmin, player.id, evt || {});
                if (!isFinalist) throw new Error("Solo los finalistas (ganadores de preselección) pueden participar en Mente más Rápida.");
            }

            // 2c. Silla Caliente (Clásico=2): solo el ganador puede entrar con el PIN
            if (gameModeId === 2) {
                const { data: ac } = await supabaseAdmin
                    .from('active_contestants')
                    .select('player_id')
                    .eq('event_id', round.event_id)
                    .maybeSingle();
                if (!ac || ac.player_id !== player.id) {
                    throw new Error("Solo el ganador de Mente más Rápida puede ingresar con este PIN. El público debe usar 'Ayudar a participante'.");
                }
            }

            // Preselección: no bloquear por sesión finalizada; el estudiante sigue hasta que el docente termine la ronda o no haya más preguntas.

            // 3. UPSERT DE SESIÓN. En preselección, si falla por duplicado (sesión con finished=true), reactivamos esa sesión.
            let session: { id: string } | null = null;
            const payload = {
                player_id: player.id,
                event_id: round.event_id,
                round_id: round.id,
                session_type: 'classroom' as const,
                finished: false
            };
            const { data: upserted, error: sErr } = await supabaseAdmin
                .from('game_sessions')
                .upsert(payload, { onConflict: 'player_id, event_id, finished' })
                .select()
                .single();

            if (sErr) {
                const isConflict = /duplicate key|unique|unique_session/i.test(sErr.message);
                if (gameModeId === 1 && isConflict) {
                    const { data: updated, error: upErr } = await supabaseAdmin
                        .from('game_sessions')
                        .update({ finished: false, round_id: round.id, session_type: 'classroom' })
                        .eq('player_id', player.id)
                        .eq('event_id', round.event_id)
                        .eq('finished', true)
                        .select()
                        .maybeSingle();
                    if (upErr) throw new Error("Error al crear sesión: " + sErr.message);
                    if (updated) {
                        session = updated;
                    } else {
                        const { data: updatedActive, error: upErr2 } = await supabaseAdmin
                            .from('game_sessions')
                            .update({ round_id: round.id, session_type: 'classroom' })
                            .eq('player_id', player.id)
                            .eq('event_id', round.event_id)
                            .eq('finished', false)
                            .select()
                            .single();
                        if (upErr2) throw new Error("Error al crear sesión: " + sErr.message);
                        session = updatedActive;
                    }
                } else {
                    throw new Error("Error al crear sesión: " + sErr.message);
                }
            } else {
                session = upserted;
            }

            // Asegurar round_id correcto (por si el upsert no actualizó la fila existente)
            await supabaseAdmin
                .from('game_sessions')
                .update({ round_id: round.id, finished: false, session_type: 'classroom' })
                .eq('player_id', player.id)
                .eq('event_id', round.event_id)
                .eq('finished', false);

            // 4. REGISTRAR EN EL EVENTO (Asegurando el grupo)
            await supabaseAdmin
                .from('event_players')
                .upsert({
                    event_id: round.event_id,
                    player_id: player.id,
                    classroom_group_id: round.classroom_group_id,
                    stage: 'lobby'
                }, { onConflict: 'event_id, player_id' });

            return { success: true, round_id: round.id };
        }
    }),
    nextQuestion: defineAction({
        accept: 'form',
        input: z.object({
            round_id: z.string(),
            question_id: z.string()
        }),
        handler: async ({ round_id, question_id }, context) => {
            await ensureStaff(context);
            const qId = parseInt(question_id);
            const rId = parseInt(round_id);

            const { data: r } = await supabaseAdmin
                .from('event_rounds')
                .select('status, events(game_mode_id, scope, program_id, faculty_id)')
                .eq('id', rId)
                .single();
            if (!r) throw new Error("Ronda no encontrada");
            const rGm = (r.events as { game_mode_id?: number })?.game_mode_id;
            const { data: np } = await context.locals.supabase.from('players').select('role').eq('auth_user_id', (await context.locals.getUser())?.id).single();
            if (np?.role === 'preseleccion' && rGm !== 1) throw new Error("Tu rol solo permite Preselección.");
            if (r.status === 'fastest_finger' || r.status === 'finished') {
                throw new Error("No se puede lanzar pregunta en esta ronda. Confirma al ganador de Mente más Rápida para continuar.");
            }
            if ((r.events as { game_mode_id?: number })?.game_mode_id === 3) {
                throw new Error("En Mente más Rápida usa 'Confirmar ganador' para pasar a Silla Caliente.");
            }

            const { data: question } = await supabaseAdmin
                .from('questions')
                .select('scope, program_id, faculty_id')
                .eq('id', qId)
                .single();
            if (!question) throw new Error("Pregunta no encontrada");
            if (!questionMatchesEventScope(question, r.events as EventScope, scopeOptionsForGameMode(rGm))) {
                throw new Error("Esta pregunta no pertenece al programa o ámbito de este evento.");
            }

            await markQuestionShown(rId, qId);
            const { error } = await supabaseAdmin
                .from('event_rounds')
                .update({
                    current_question_id: qId,
                    question_started_at: new Date().toISOString(),
                    status: 'active'
                })
                .eq('id', rId);

            if (error) throw new Error(error.message);
            return { success: true, message: "¡Pregunta lanzada a los estudiantes!" };
        }
    }),
    submitAnswer: defineAction({
        accept: 'form',
        input: z.object({
            round_id: z.string(),
            question_id: z.string(),
            answer_id: z.string(),
            session_id: z.string(),
        }),
        handler: async (input, context) => {
            console.log('[submitAnswer] INICIO - input:', JSON.stringify(input));
            const user = await context.locals.getUser();
            if (!user) throw new Error("Debes iniciar sesión");

            const now = Date.now();
            const { round_id, question_id, answer_id, session_id } = input;

            const sessionIdNum = parseInt(session_id, 10);
            if (isNaN(sessionIdNum)) throw new Error("Sesión inválida. Vuelve a unirte con el PIN.");

            // 1. Obtener datos (Carga rápida)
            const [roundRes, questionRes, answerRes, playerRes] = await Promise.all([
                supabaseAdmin.from('event_rounds').select('*, events(game_mode_id, scope, program_id, faculty_id)').eq('id', parseInt(round_id)).single(),
                supabaseAdmin.from('questions').select('*, game_levels(points, time_limit), scope, program_id, faculty_id').eq('id', parseInt(question_id)).single(),
                supabaseAdmin.from('answers').select('is_correct, question_id').eq('id', parseInt(answer_id)).single(),
                supabaseAdmin.from('players').select('id').eq('auth_user_id', user?.id).single()
            ]);

            if (!roundRes.data) throw new Error("Ronda no encontrada");
            if (!roundRes.data?.question_started_at) throw new Error("Pregunta no iniciada");

            // Validar que la respuesta pertenece a la pregunta y es la pregunta actual
            const qId = parseInt(question_id);
            if (!answerRes.data) throw new Error("Respuesta no encontrada");
            if (answerRes.data.question_id !== qId) throw new Error("Respuesta inválida para esta pregunta");
            if (roundRes.data?.current_question_id !== qId) throw new Error("Esta pregunta ya no está activa");
            if (!questionRes.data) throw new Error("Pregunta no encontrada");
            const gameModeId = (roundRes.data?.events as { game_mode_id?: number })?.game_mode_id;
            assertQuestionMatchesEventScope(
                questionRes.data,
                roundRes.data.events as EventScope,
                gameModeId
            );
            const startTime = new Date(roundRes.data.question_started_at).getTime();
            const responseMs = now - startTime;
            const limitMs = (gameModeId === 1 ? 30 : ((questionRes.data?.game_levels as any)?.time_limit || 30)) * 1000;
            const isCorrect = answerRes.data?.is_correct ?? false;

            // Validar que la sesión pertenezca al jugador y al evento de la ronda (evitar IDOR)
            const { data: gameSession } = await supabaseAdmin
                .from('game_sessions')
                .select('id, player_id, event_id')
                .eq('id', sessionIdNum)
                .single();

            if (!playerRes.data?.id) throw new Error("Jugador no encontrado");
            if (!gameSession || gameSession.player_id !== playerRes.data.id) {
                throw new Error("Sesión de juego inválida");
            }
            if (gameSession.event_id !== roundRes.data.event_id) {
                throw new Error("La sesión no corresponde a esta ronda");
            }

            const isJuegoFinal = (roundRes.data?.events as { game_mode_id?: number })?.game_mode_id === 2;
            let points = 0;
            if (isCorrect) {
                const base = (questionRes.data.game_levels as any).points || 1000;
                if (isJuegoFinal) {
                    // Juego final: sin tiempo, puntos completos al ritmo del docente
                    points = base;
                } else {
                    // Preselección: más rápido = más puntos
                    const ratio = Math.max(0, (limitMs - responseMs) / limitMs);
                    points = Math.round(base * (0.05 + (ratio * 0.95)));
                }
            }

            // 2. Insertar respuesta (asegurar que event_players existe para total_time_ms)
            await supabaseAdmin.from('event_players').upsert({
                event_id: roundRes.data.event_id,
                player_id: playerRes.data.id,
                classroom_group_id: roundRes.data.classroom_group_id ?? '',
                stage: 'playing'
            }, { onConflict: 'event_id, player_id' });

            const levelId = (questionRes.data as any)?.level_id ?? (questionRes.data?.game_levels as any)?.id ?? 1;
            const saved = await saveGameAnswerIdempotent({
                gameSessionId: sessionIdNum,
                roundId: parseInt(round_id, 10),
                eventId: roundRes.data.event_id,
                playerId: playerRes.data.id,
                classroomGroupId: roundRes.data.classroom_group_id ?? '',
                questionId: parseInt(question_id, 10),
                answerId: parseInt(answer_id, 10),
                isCorrect,
                responseTimeMs: responseMs,
                moneyAtQuestion: points,
                levelId: typeof levelId === 'number' ? levelId : parseInt(String(levelId), 10) || 1,
            });

            if (!saved.alreadyAnswered) {
                if (points > 0) {
                    await supabaseAdmin.rpc('registrar_puntaje_ganado', {
                        p_session_id: sessionIdNum,
                        p_event_id: roundRes.data.event_id,
                        p_player_id: playerRes.data.id,
                        p_puntos: points,
                    });
                }
                const { error: timeErr } = await supabaseAdmin.rpc('add_player_time', {
                    p_player_id: playerRes.data.id,
                    p_event_id: roundRes.data.event_id,
                    p_response_ms: responseMs,
                });
                if (timeErr) console.error('add_player_time:', timeErr.message);
            }

            const resp = {
                success: true,
                correct: saved.isCorrect,
                points: saved.points,
                time: (responseMs / 1000).toFixed(2),
                insertId: saved.insertId,
            };
            console.log('[submitAnswer] ÉXITO - retornando:', resp);
            return resp;
        }
    }),

    /** Silla Caliente: el participante se retira y se lleva lo acumulado. Deja constancia en BD (stage=retirado, score). */
    withdrawFromSillaCaliente: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            const user = await context.locals.getUser();
            if (!user) throw new Error("Debes iniciar sesión");

            const rId = parseInt(round_id);
            if (!Number.isFinite(rId)) throw new Error("Ronda inválida");

            const { data: player } = await supabaseAdmin.from('players').select('id').eq('auth_user_id', user.id).single();
            if (!player) throw new Error("Jugador no encontrado");

            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('id, event_id, classroom_group_id, status, events(game_mode_id)')
                .eq('id', rId)
                .single();
            if (!round) throw new Error("Ronda no encontrada");
            if ((round.events as { game_mode_id?: number })?.game_mode_id !== 2) {
                throw new Error("Solo puedes retirarte en Silla Caliente");
            }
            if (round.status === 'finished') {
                throw new Error("Esta ronda ya terminó");
            }

            const { data: ac } = await supabaseAdmin.from('active_contestants').select('player_id').eq('event_id', round.event_id).maybeSingle();
            if (!ac || ac.player_id !== player.id) {
                throw new Error("Solo el participante que está en la silla puede retirarse");
            }

            const { data: gs } = await supabaseAdmin.from('game_sessions').select('id, score').eq('player_id', player.id).eq('event_id', round.event_id).eq('finished', false).maybeSingle();
            const { data: ep } = await supabaseAdmin.from('event_players').select('score').eq('event_id', round.event_id).eq('player_id', player.id).eq('classroom_group_id', round.classroom_group_id ?? '').maybeSingle();
            const accumulatedScore = gs?.score ?? ep?.score ?? 0;

            if (gs) {
                await supabaseAdmin.from('game_sessions').update({ score: accumulatedScore, finished: true }).eq('id', gs.id);
            }
            await supabaseAdmin.from('event_players').update({ score: accumulatedScore, stage: 'retirado' })
                .eq('event_id', round.event_id).eq('player_id', player.id).eq('classroom_group_id', round.classroom_group_id ?? '');

            await supabaseAdmin.from('active_contestants').delete().eq('event_id', round.event_id).eq('player_id', player.id);

            const { data: evt } = await supabaseAdmin.from('event_rounds').select('events(season_id)').eq('id', rId).single();
            const seasonId = (evt?.events as { season_id?: number })?.season_id;
            if (seasonId && accumulatedScore > 0) {
                const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', accumulatedScore);
                await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: player.id, score: accumulatedScore, position: (count ?? 0) + 1 });
            }

            const formatted = accumulatedScore.toLocaleString('es-CO');
            return { success: true, score: accumulatedScore, message: `Te retiraste con $${formatted} acumulados.` };
        }
    }),

    launchRandomQuestion: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            await ensureStaff(context);

            // 1. Obtener datos de la ronda y el programa
            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('*, events(scope, program_id, faculty_id, game_mode_id)')
                .eq('id', parseInt(round_id))
                .single();

            if (!round) throw new Error("Ronda no encontrada");

            const gameModeId = (round.events as { game_mode_id?: number })?.game_mode_id;
            const { data: myProfile } = await context.locals.supabase.from('players').select('role').eq('auth_user_id', (await context.locals.getUser())?.id).single();
            if (myProfile?.role === 'preseleccion' && gameModeId !== 1) {
                throw new Error("Tu rol solo permite Preselección.");
            }
            if (gameModeId === 3) {
                throw new Error("En Mente más Rápida no se lanzan preguntas. Usa 'Confirmar ganador' para pasar a Silla Caliente.");
            }
            if (round.status === 'fastest_finger') {
                throw new Error("La ronda está en Mente más Rápida. Confirma al ganador para continuar a Silla Caliente.");
            }
            if (round.status === 'finished') {
                throw new Error("Esta ronda ya terminó. Abre la ronda de Silla Caliente para continuar.");
            }

            // 1b. Silla Caliente: obtener semestre del concursante activo para filtrar preguntas
            let playerSemester: number | null = null;
            if (gameModeId === 2) {
                const { data: ac } = await supabaseAdmin
                    .from('active_contestants')
                    .select('player_id')
                    .eq('event_id', round.event_id)
                    .maybeSingle();
                if (ac?.player_id) {
                    const { data: pl } = await supabaseAdmin
                        .from('players')
                        .select('semester')
                        .eq('id', ac.player_id)
                        .single();
                    if (pl?.semester != null) playerSemester = pl.semester;
                }
            }

            // 2. Preguntas ya usadas: round_questions_shown (o fallback a game_answers)
            let usedIds: number[] = [];
            try {
                const { data: shown } = await supabaseAdmin
                    .from('round_questions_shown')
                    .select('question_id')
                    .eq('round_id', round.id);
                if (shown && shown.length > 0) {
                    usedIds = [...new Set(shown.map((s: { question_id: number }) => s.question_id).filter(Boolean))];
                }
            } catch (_) { /* tabla puede no existir */ }
            if (usedIds.length === 0) {
                const { data: answered } = await supabaseAdmin
                    .from('game_answers')
                    .select('question_id')
                    .eq('round_id', round.id);
                const fromAnswers = (answered || []).map((a: { question_id: number }) => a.question_id).filter(Boolean);
                const currentQ = round.current_question_id ? [round.current_question_id] : [];
                usedIds = [...new Set([...fromAnswers, ...currentQ])];
            }

            // 3. Preguntas disponibles: Nivel 1 (difficulty_order=1), activas.
            const { data: firstLevel } = await supabaseAdmin
                .from('game_levels')
                .select('id')
                .eq('difficulty_order', 1)
                .maybeSingle();
            const firstLevelId = firstLevel?.id ?? 1;

            const scopeOpts = scopeOptionsForGameMode(gameModeId);

            let query = supabaseAdmin
                .from('questions')
                .select('id, scope, program_id, faculty_id')
                .eq('level_id', firstLevelId)
                .eq('active', true);
            query = applyScopeFilter(query, round.events as EventScope);

            // Silla Caliente: solo preguntas cuyo rango [min_semester, max_semester] incluya el semestre del estudiante
            if (playerSemester != null) {
                query = query.lte('min_semester', playerSemester).gte('max_semester', playerSemester);
            }

            const { data: allMatching } = await query;

            const scoped = filterQuestionsByEventScope(allMatching || [], round.events as EventScope, scopeOpts);

            // Filtrar en JS para garantizar que NUNCA repetimos (más fiable que .not() de Supabase)
            const availableIds = scoped
                .map((q) => q.id)
                .filter((id: number) => !usedIds.includes(id));

            if (availableIds.length === 0) {
                const evtScope = normalizeEventScope(round.events as EventScope);
                const scopeHint =
                    gameModeId === 1 && evtScope?.scope === 'program'
                        ? ' para este programa'
                        : gameModeId === 1 && evtScope?.scope === 'faculty'
                          ? ' para esta facultad'
                          : '';
                const semHint = playerSemester != null ? ` (semestre ${playerSemester} o compatible)` : '';
                throw new Error(`¡Se agotaron las preguntas de este nivel${scopeHint} para esta sesión${semHint}! Puedes finalizar el juego o agregar más preguntas de Nivel 1.`);
            }

            // 4. Azar y actualización (solo de las no usadas)
            const chosenId = availableIds[Math.floor(Math.random() * availableIds.length)];
            const randomQ = scoped.find((q) => q.id === chosenId);

            if (!randomQ) throw new Error("Error al seleccionar pregunta");

            await markQuestionShown(round.id, randomQ.id);

            // Actualizar stage a 'playing' cuando inicia el juego (desde waiting)
            await supabaseAdmin.from('event_players').update({ stage: 'playing' })
                .eq('event_id', round.event_id)
                .eq('classroom_group_id', round.classroom_group_id);

            await supabaseAdmin.from('event_rounds').update({
                current_question_id: randomQ.id,
                question_started_at: new Date().toISOString(),
                status: 'active'
            }).eq('id', round.id);

            return { success: true };
        }
    }),
    verifyClasicoAnswer: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            await ensureStaff(context);
            const rId = parseInt(round_id);

            const { data: round } = await supabaseAdmin.from('event_rounds').select('current_question_id').eq('id', rId).single();
            if (!round?.current_question_id) throw new Error("Ronda o pregunta no encontrada");

            const { data: sel } = await supabaseAdmin
                .from('student_answer_selection')
                .select('player_id, answer_id')
                .eq('round_id', rId)
                .eq('question_id', round.current_question_id)
                .limit(1)
                .single();

            if (!sel) throw new Error("El estudiante no ha marcado ninguna opción");

            const { data: answer } = await supabaseAdmin.from('answers').select('is_correct').eq('id', sel.answer_id).single();
            if (!answer) throw new Error("Respuesta no encontrada");

            const correct = answer.is_correct === true;
            const { data: correctAns } = await supabaseAdmin.from('answers').select('id').eq('question_id', round.current_question_id).eq('is_correct', true).limit(1).maybeSingle();
            const correctAnswerId = correctAns?.id ?? sel.answer_id;
            const verificationResult = { question_id: round.current_question_id, is_correct: correct, correct_answer_id: correctAnswerId, student_answer_id: sel.answer_id } as const;
            const { data: roundFull } = await supabaseAdmin.from('event_rounds').select('*, events(scope, program_id, faculty_id, season_id, game_mode_id)').eq('id', rId).single();
            if (!roundFull) throw new Error("Ronda no encontrada");
            const gm = (roundFull.events as { game_mode_id?: number })?.game_mode_id;
            const isPreseleccion = gm === 1;
            const { data: vp } = await context.locals.supabase.from('players').select('role').eq('auth_user_id', (await context.locals.getUser())?.id).single();
            if (vp?.role === 'preseleccion' && gm !== 1) throw new Error("Tu rol solo permite Preselección.");

            const { data: question } = await supabaseAdmin.from('questions').select('level_id').eq('id', round.current_question_id).single();
            const { data: level } = await supabaseAdmin.from('game_levels').select('id, money_value, points, difficulty_order').eq('id', question?.level_id || 1).single();
            const { data: gameSession } = await supabaseAdmin.from('game_sessions').select('id').eq('player_id', sel.player_id).eq('event_id', roundFull.event_id).eq('finished', false).maybeSingle();
            if (!gameSession) throw new Error("Sesión de juego no encontrada");

            if (correct) {
                await supabaseAdmin.rpc('insert_game_answer', { p_game_session_id: gameSession.id, p_round_id: rId, p_event_id: roundFull.event_id, p_player_id: sel.player_id, p_classroom_group_id: roundFull.classroom_group_id ?? '', p_question_id: round.current_question_id, p_answer_id: sel.answer_id, p_is_correct: true, p_response_time_ms: 0, p_money_at_question: level?.points || 1000, p_level_id: question?.level_id || 1 });
                await supabaseAdmin.rpc('registrar_puntaje_ganado', { p_session_id: gameSession.id, p_event_id: roundFull.event_id, p_player_id: sel.player_id, p_puntos: level?.points || 1000 });
                await supabaseAdmin.from('student_answer_selection').delete().eq('round_id', rId).eq('question_id', round.current_question_id);
                const currentOrder = level?.difficulty_order ?? 1;
                const { data: nextLevel } = await supabaseAdmin.from('game_levels').select('id').eq('difficulty_order', currentOrder + 1).maybeSingle();
                const nextLevelId = nextLevel?.id;
                let usedIds: number[] = [];
                const { data: shown } = await supabaseAdmin.from('round_questions_shown').select('question_id').eq('round_id', rId);
                if (shown?.length) usedIds = shown.map((s: any) => s.question_id).filter(Boolean);
                usedIds.push(round.current_question_id);
                if (!nextLevelId) {
                    const winPrize = level?.money_value ?? level?.points ?? 0;
                    await supabaseAdmin.from('game_sessions').update({ score: winPrize, finished: true }).eq('id', gameSession.id);
                    await supabaseAdmin.from('event_players').update({ score: winPrize, stage: 'finished' }).eq('event_id', roundFull.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '');
                    const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id').eq('event_id', roundFull.event_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '').order('score', { ascending: false }).order('total_time_ms', { ascending: true });
                    if (ranked?.length) { for (let i = 0; i < ranked.length; i++) { await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 }).eq('event_id', roundFull.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? ''); } }
                    const seasonId = (roundFull.events as { season_id?: number })?.season_id;
                    if (seasonId) {
                        const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', winPrize);
                        await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: winPrize, position: (count ?? 0) + 1 });
                    }
                    await supabaseAdmin.from('event_rounds').update({ status: 'finished', verification_result: verificationResult }).eq('id', rId);
                    return { success: true, message: "¡Correcto! No hay más preguntas. ¡Ganó!", finished: true };
                }
                // Silla Caliente: filtrar por semestre del estudiante (min_semester <= semestre <= max_semester)
                const { data: plSem } = await supabaseAdmin.from('players').select('semester').eq('id', sel.player_id).single();
                const playerSemester = plSem?.semester ?? null;

                let query = supabaseAdmin.from('questions').select('id').eq('level_id', nextLevelId).eq('active', true);
                query = applyScopeFilter(query, roundFull.events as EventScope);
                if (playerSemester != null) query = query.lte('min_semester', playerSemester).gte('max_semester', playerSemester);
                const { data: available } = await query;
                const availableIds = (available || []).map((q: any) => q.id).filter((id: number) => !usedIds.includes(id));
                if (availableIds.length === 0) {
                    const winPrize = level?.money_value ?? level?.points ?? 0;
                    await supabaseAdmin.from('game_sessions').update({ score: winPrize, finished: true }).eq('id', gameSession.id);
                    await supabaseAdmin.from('event_players').update({ score: winPrize, stage: 'finished' }).eq('event_id', roundFull.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '');
                    const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id').eq('event_id', roundFull.event_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '').order('score', { ascending: false }).order('total_time_ms', { ascending: true });
                    if (ranked?.length) { for (let i = 0; i < ranked.length; i++) { await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 }).eq('event_id', roundFull.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? ''); } }
                    const seasonId = (roundFull.events as { season_id?: number })?.season_id;
                    if (seasonId) {
                        const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', winPrize);
                        await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: winPrize, position: (count ?? 0) + 1 });
                    }
                    await supabaseAdmin.from('event_rounds').update({ status: 'finished', verification_result: verificationResult }).eq('id', rId);
                    return { success: true, message: "¡Correcto! No hay más preguntas. ¡Ganó!", finished: true };
                }
                const chosenId = availableIds[Math.floor(Math.random() * availableIds.length)];
                const { data: verifyQ } = await supabaseAdmin.from('questions').select('level_id').eq('id', chosenId).single();
                if (!verifyQ || verifyQ.level_id !== nextLevelId) throw new Error("Error al seleccionar pregunta del nivel correcto.");
                await markQuestionShown(rId, chosenId);
                await supabaseAdmin.from('event_rounds').update({ current_question_id: chosenId, question_started_at: new Date().toISOString(), verification_result: verificationResult }).eq('id', rId);
                return { success: true, message: "¡Correcto! Siguiente nivel." };
            } else {
                // Respuesta incorrecta
                await supabaseAdmin.rpc('insert_game_answer', { p_game_session_id: gameSession.id, p_round_id: rId, p_event_id: roundFull.event_id, p_player_id: sel.player_id, p_classroom_group_id: roundFull.classroom_group_id ?? '', p_question_id: round.current_question_id, p_answer_id: sel.answer_id, p_is_correct: false, p_response_time_ms: 0, p_money_at_question: 0, p_level_id: question?.level_id || 1 });
                await supabaseAdmin.from('student_answer_selection').delete().eq('round_id', rId).eq('question_id', round.current_question_id);

                if (isPreseleccion) {
                    // Preselección: no sacar al estudiante; no marcar sesión ni ronda como terminadas
                    await supabaseAdmin.from('event_rounds').update({ verification_result: verificationResult }).eq('id', rId);
                    return { success: true, message: "Incorrecto. Sigue participando.", finished: false };
                }

                // Clásico (Silla Caliente): premio por seguros y terminar sesión
                const { data: allLevels } = await supabaseAdmin.from('game_levels').select('id, difficulty_order, money_value, is_safe_level').order('difficulty_order', { ascending: true });
                const currentOrder = allLevels?.find((l: any) => l.id === question?.level_id)?.difficulty_order ?? 1;
                const levelsPassed = (allLevels || []).filter((l: any) => l.difficulty_order < currentOrder);
                const safeLevelsPassed = levelsPassed.filter((l: any) => l.is_safe_level);
                let prizeMoney = 0;
                if (safeLevelsPassed.length > 0) prizeMoney = safeLevelsPassed[safeLevelsPassed.length - 1].money_value || 0;
                await supabaseAdmin.from('game_sessions').update({ score: prizeMoney, finished: true }).eq('id', gameSession.id);
                await supabaseAdmin.from('event_players').update({ score: prizeMoney, stage: 'finished' }).eq('event_id', roundFull.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '');
                const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id').eq('event_id', roundFull.event_id).eq('classroom_group_id', roundFull.classroom_group_id ?? '').order('score', { ascending: false }).order('total_time_ms', { ascending: true }).order('player_id', { ascending: true });
                if (ranked?.length) { for (let i = 0; i < ranked.length; i++) { await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 }).eq('event_id', roundFull.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', roundFull.classroom_group_id ?? ''); } }
                const seasonId = (roundFull.events as { season_id?: number })?.season_id;
                if (seasonId) {
                    const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', prizeMoney);
                    await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: prizeMoney, position: (count ?? 0) + 1 });
                }
                await supabaseAdmin.from('event_rounds').update({ status: 'finished', verification_result: verificationResult }).eq('id', rId);
                return { success: true, message: `Incorrecto. Premio: $${prizeMoney.toLocaleString('es-CO')}`, finished: true };
            }
        }
    }),
    evaluateClasicoAnswer: defineAction({
        accept: 'form',
        input: z.object({
            round_id: z.string(),
            is_correct: z.enum(['true', 'false']),
        }),
        handler: async ({ round_id, is_correct }, context) => {
            await ensureStaffFull(context); // Clásico: preseleccion no puede

            const rId = parseInt(round_id);
            const correct = is_correct === 'true';

            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('*, events(scope, program_id, faculty_id, season_id, game_mode_id)')
                .eq('id', rId)
                .single();

            if (!round || !round.current_question_id) throw new Error("Ronda o pregunta no encontrada");
            const isPreseleccionEval = (round.events as { game_mode_id?: number })?.game_mode_id === 1;

            const { data: sel } = await supabaseAdmin
                .from('student_answer_selection')
                .select('player_id, answer_id')
                .eq('round_id', rId)
                .eq('question_id', round.current_question_id)
                .limit(1)
                .single();

            if (!sel) throw new Error("El estudiante no ha marcado ninguna opción");

            const { data: question } = await supabaseAdmin
                .from('questions')
                .select('level_id')
                .eq('id', round.current_question_id)
                .single();

            const { data: answer } = await supabaseAdmin
                .from('answers')
                .select('is_correct')
                .eq('id', sel.answer_id)
                .single();

            const { data: level } = await supabaseAdmin
                .from('game_levels')
                .select('id, money_value, points, difficulty_order')
                .eq('id', question?.level_id || 1)
                .single();

            const { data: gameSession } = await supabaseAdmin
                .from('game_sessions')
                .select('id')
                .eq('player_id', sel.player_id)
                .eq('event_id', round.event_id)
                .eq('finished', false)
                .maybeSingle();

            if (!gameSession) throw new Error("Sesión de juego no encontrada");

            if (correct) {
                // Registrar respuesta correcta
                await supabaseAdmin.rpc('insert_game_answer', {
                    p_game_session_id: gameSession.id,
                    p_round_id: rId,
                    p_event_id: round.event_id,
                    p_player_id: sel.player_id,
                    p_classroom_group_id: round.classroom_group_id ?? '',
                    p_question_id: round.current_question_id,
                    p_answer_id: sel.answer_id,
                    p_is_correct: true,
                    p_response_time_ms: 0,
                    p_money_at_question: level?.points || 1000,
                    p_level_id: question?.level_id || 1,
                });

                await supabaseAdmin.rpc('registrar_puntaje_ganado', {
                    p_session_id: gameSession.id,
                    p_event_id: round.event_id,
                    p_player_id: sel.player_id,
                    p_puntos: level?.points || 1000,
                });

                await supabaseAdmin.from('student_answer_selection').delete()
                    .eq('round_id', rId).eq('question_id', round.current_question_id);

                // Lanzar siguiente pregunta (nivel + 1 por difficulty_order)
                const currentOrder = level?.difficulty_order ?? 1;
                const { data: nextLevel } = await supabaseAdmin
                    .from('game_levels')
                    .select('id')
                    .eq('difficulty_order', currentOrder + 1)
                    .maybeSingle();
                const nextLevelId = nextLevel?.id;

                let usedIds: number[] = [];
                const { data: shown } = await supabaseAdmin.from('round_questions_shown').select('question_id').eq('round_id', rId);
                if (shown?.length) usedIds = shown.map((s: any) => s.question_id).filter(Boolean);
                usedIds.push(round.current_question_id);

                // Si no hay siguiente nivel o no hay preguntas para ese nivel → ganó
                if (!nextLevelId) {
                    const winPrize = level?.money_value ?? level?.points ?? 0;
                    await supabaseAdmin.from('game_sessions').update({ score: winPrize, finished: true }).eq('id', gameSession.id);
                    await supabaseAdmin.from('event_players').update({ score: winPrize, stage: 'finished' }).eq('event_id', round.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                    const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id').eq('event_id', round.event_id).eq('classroom_group_id', round.classroom_group_id ?? '').order('score', { ascending: false }).order('total_time_ms', { ascending: true });
                    if (ranked?.length) {
                        for (let i = 0; i < ranked.length; i++) {
                            await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 }).eq('event_id', round.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                        }
                    }
                    const seasonId = (round.events as { season_id?: number })?.season_id;
                    if (seasonId) {
                        const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', winPrize);
                        await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: winPrize, position: (count ?? 0) + 1 });
                    }
                    await supabaseAdmin.from('event_rounds').update({ status: 'finished' }).eq('id', rId);
                    return { success: true, message: "¡Correcto! No hay más preguntas. ¡Ganó!", finished: true };
                }

                // Silla Caliente: filtrar por semestre del estudiante (min_semester <= semestre <= max_semester)
                const { data: plSem } = await supabaseAdmin.from('players').select('semester').eq('id', sel.player_id).single();
                const playerSemester = plSem?.semester ?? null;

                let query = supabaseAdmin.from('questions').select('id').eq('level_id', nextLevelId).eq('active', true);
                query = applyScopeFilter(query, round.events as EventScope);
                if (playerSemester != null) query = query.lte('min_semester', playerSemester).gte('max_semester', playerSemester);
                const { data: available } = await query;

                const availableIds = (available || []).map((q: any) => q.id).filter((id: number) => !usedIds.includes(id));

                if (availableIds.length === 0) {
                    // No hay preguntas para el siguiente nivel: usa el premio del nivel actual
                    const winPrize = level?.money_value ?? level?.points ?? 0;
                    await supabaseAdmin.from('game_sessions').update({ score: winPrize, finished: true }).eq('id', gameSession.id);
                    await supabaseAdmin.from('event_players').update({ score: winPrize, stage: 'finished' }).eq('event_id', round.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                    const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id').eq('event_id', round.event_id).eq('classroom_group_id', round.classroom_group_id ?? '').order('score', { ascending: false }).order('total_time_ms', { ascending: true });
                    if (ranked?.length) {
                        for (let i = 0; i < ranked.length; i++) {
                            await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 }).eq('event_id', round.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                        }
                    }
                    const seasonId = (round.events as { season_id?: number })?.season_id;
                    if (seasonId) {
                        const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', winPrize);
                        await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: winPrize, position: (count ?? 0) + 1 });
                    }
                    await supabaseAdmin.from('event_rounds').update({ status: 'finished' }).eq('id', rId);
                    return { success: true, message: "¡Correcto! No hay más preguntas. ¡Ganó!", finished: true };
                }

                const chosenId = availableIds[Math.floor(Math.random() * availableIds.length)];
                const { data: verifyQ } = await supabaseAdmin.from('questions').select('level_id').eq('id', chosenId).single();
                if (!verifyQ || verifyQ.level_id !== nextLevelId) {
                    console.error('[evaluateClasico] Nivel incoherente: chosenId=', chosenId, 'expected level=', nextLevelId, 'got=', verifyQ?.level_id);
                    throw new Error("Error al seleccionar pregunta del nivel correcto. Intenta de nuevo.");
                }
                await markQuestionShown(rId, chosenId);
                await supabaseAdmin.from('event_rounds').update({
                    current_question_id: chosenId,
                    question_started_at: new Date().toISOString(),
                }).eq('id', rId);

                return { success: true, message: "¡Correcto! Siguiente nivel." };
            } else {
                // Respuesta incorrecta
                await supabaseAdmin.rpc('insert_game_answer', {
                    p_game_session_id: gameSession.id,
                    p_round_id: rId,
                    p_event_id: round.event_id,
                    p_player_id: sel.player_id,
                    p_classroom_group_id: round.classroom_group_id ?? '',
                    p_question_id: round.current_question_id,
                    p_answer_id: sel.answer_id,
                    p_is_correct: false,
                    p_response_time_ms: 0,
                    p_money_at_question: 0,
                    p_level_id: question?.level_id || 1,
                });
                await supabaseAdmin.from('student_answer_selection').delete().eq('round_id', rId).eq('question_id', round.current_question_id);

                if (isPreseleccionEval) {
                    // Preselección: no sacar al estudiante; no marcar sesión ni ronda como terminadas
                    return { success: true, message: "Incorrecto. Sigue participando.", finished: false };
                }

                // Clásico: premio por seguros y terminar sesión
                const { data: allLevels } = await supabaseAdmin
                    .from('game_levels')
                    .select('id, difficulty_order, money_value, is_safe_level')
                    .order('difficulty_order', { ascending: true });

                const currentOrder = allLevels?.find((l: any) => l.id === question?.level_id)?.difficulty_order ?? 1;
                const levelsPassed = (allLevels || []).filter((l: any) => l.difficulty_order < currentOrder);
                const safeLevelsPassed = levelsPassed.filter((l: any) => l.is_safe_level);

                let prizeMoney = 0;
                if (safeLevelsPassed.length > 0) {
                    const lastSafe = safeLevelsPassed[safeLevelsPassed.length - 1];
                    prizeMoney = lastSafe.money_value || 0;
                }

                await supabaseAdmin.from('game_sessions').update({ score: prizeMoney, finished: true }).eq('id', gameSession.id);
                await supabaseAdmin.from('event_players').update({ score: prizeMoney, stage: 'finished' }).eq('event_id', round.event_id).eq('player_id', sel.player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                const { data: ranked } = await supabaseAdmin.from('event_players').select('player_id')
                    .eq('event_id', round.event_id).eq('classroom_group_id', round.classroom_group_id ?? '')
                    .order('score', { ascending: false }).order('total_time_ms', { ascending: true }).order('player_id', { ascending: true });
                if (ranked?.length) {
                    for (let i = 0; i < ranked.length; i++) {
                        await supabaseAdmin.from('event_players').update({ final_rank: i + 1, is_finalist: i === 0 })
                            .eq('event_id', round.event_id).eq('player_id', ranked[i].player_id).eq('classroom_group_id', round.classroom_group_id ?? '');
                    }
                }
                const seasonId = (round.events as { season_id?: number })?.season_id;
                if (seasonId) {
                    const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', prizeMoney);
                    await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: sel.player_id, score: prizeMoney, position: (count ?? 0) + 1 });
                }
                await supabaseAdmin.from('event_rounds').update({ status: 'finished' }).eq('id', rId);
                return { success: true, message: `Incorrecto. Premio: $${prizeMoney.toLocaleString('es-CO')}`, finished: true };
            }
        }
    }),

    finishRound: defineAction({
        accept: 'form',
        input: z.object({ round_id: z.string() }),
        handler: async ({ round_id }, context) => {
            await ensureStaff(context);

            const rId = parseInt(round_id);
            const { data: round } = await supabaseAdmin
                .from('event_rounds')
                .select('event_id, classroom_group_id, events(game_mode_id, season_id)')
                .eq('id', rId)
                .single();

            if (!round) throw new Error("Ronda no encontrada");

            const evt = round.events as { game_mode_id?: number; season_id?: number } | null;
            const gameModeId = evt?.game_mode_id;
            const { data: fp } = await context.locals.supabase.from('players').select('role').eq('auth_user_id', (await context.locals.getUser())?.id).single();
            if (fp?.role === 'preseleccion' && gameModeId !== 1) throw new Error("Tu rol solo permite Preselección.");

            const isClasico = gameModeId === 2;

            // Si es Clásico (Silla Caliente): marcar game_sessions y event_players del participante activo
            if (isClasico) {
                const { data: ac } = await supabaseAdmin.from('active_contestants').select('player_id').eq('event_id', round.event_id).maybeSingle();
                if (ac?.player_id) {
                    const { data: gs } = await supabaseAdmin.from('game_sessions').select('id, score').eq('player_id', ac.player_id).eq('event_id', round.event_id).eq('finished', false).maybeSingle();
                    const { data: ep } = await supabaseAdmin.from('event_players').select('score').eq('event_id', round.event_id).eq('player_id', ac.player_id).eq('classroom_group_id', round.classroom_group_id ?? '').maybeSingle();
                    const finalScore = gs?.score ?? ep?.score ?? 0;

                    if (gs) {
                        await supabaseAdmin.from('game_sessions').update({ score: finalScore, finished: true }).eq('id', gs.id);
                    }
                    await supabaseAdmin.from('event_players').update({ score: finalScore, stage: 'finished' })
                        .eq('event_id', round.event_id).eq('player_id', ac.player_id).eq('classroom_group_id', round.classroom_group_id ?? '');

                    const seasonId = evt?.season_id;
                    if (seasonId && finalScore > 0) {
                        const { count } = await supabaseAdmin.from('season_rankings').select('*', { count: 'exact', head: true }).eq('season_id', seasonId).gt('score', finalScore);
                        await supabaseAdmin.from('season_rankings').insert({ season_id: seasonId, player_id: ac.player_id, score: finalScore, position: (count ?? 0) + 1 });
                    }
                }
            }

            // Calcular y guardar final_rank (score DESC, total_time_ms ASC)
            const groupId = round.classroom_group_id ?? '';
            let ranked = (await supabaseAdmin
                .from('event_players')
                .select('player_id')
                .eq('event_id', round.event_id)
                .eq('classroom_group_id', groupId)
                .order('score', { ascending: false })
                .order('total_time_ms', { ascending: true })
                .order('player_id', { ascending: true })).data;
            if (!ranked?.length && groupId) {
                ranked = (await supabaseAdmin
                    .from('event_players')
                    .select('player_id')
                    .eq('event_id', round.event_id)
                    .order('score', { ascending: false })
                    .order('total_time_ms', { ascending: true })
                    .order('player_id', { ascending: true })).data;
            }

            if (ranked?.length) {
                for (let i = 0; i < ranked.length; i++) {
                    const isWinner = i === 0;
                    await supabaseAdmin.from('event_players').update({
                        final_rank: i + 1,
                        is_finalist: isWinner,
                        ...(isClasico ? { stage: 'finished' as const } : {}),
                        ...(groupId ? { classroom_group_id: groupId } : {})
                    })
                        .eq('event_id', round.event_id)
                        .eq('player_id', ranked[i].player_id);
                }
            }

            const isMenteRapida = evt?.game_mode_id === 3;
            if (isMenteRapida) {
                // Transición a Mente más Rápida (fastest_finger) tras preselección
                const { data: allSeqs } = await supabaseAdmin.from('fastest_finger_sequences').select('id');
                if (allSeqs?.length) {
                    const seqId = allSeqs[Math.floor(Math.random() * allSeqs.length)].id;
                    const { data: existing } = await supabaseAdmin.from('fastest_finger_rounds').select('id').eq('event_round_id', rId).maybeSingle();
                    if (!existing) {
                        await supabaseAdmin.from('fastest_finger_rounds').insert({ event_round_id: rId, sequence_id: seqId });
                    } else {
                        await supabaseAdmin.from('fastest_finger_rounds').update({ sequence_id: seqId, started_at: new Date().toISOString() }).eq('event_round_id', rId);
                    }
                    const { error: err } = await supabaseAdmin.from('event_rounds').update({ status: 'fastest_finger', question_started_at: new Date().toISOString() }).eq('id', rId);
                    if (err) throw new Error(err.message);
                    return { success: true, message: "Preselección finalizada. ¡Mente más Rápida activada!" };
                }
            }

            const { error } = await supabaseAdmin
                .from('event_rounds')
                .update({ status: 'finished' })
                .eq('id', rId);

            if (error) throw new Error(error.message);
            return { success: true, message: "Juego finalizado" };
        }
    })
};