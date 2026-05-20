import type { APIRoute } from "astro";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadClasicoCurrentQuestion } from "@/lib/clasicoQuestionView";
import { loadFastestFingerAttempts } from "@/lib/fastestFingerResults";
import { seededShuffle } from "@/lib/utils";

/**
 * API para el panel de control: devuelve estudiantes conectados y/o que respondieron.
 * Usa supabaseAdmin para game_answers (bypassa RLS) y asegura que se vean las respuestas.
 */
export const GET: APIRoute = async ({ locals, url }) => {
    const roundId = url.searchParams.get("round_id");
    if (!roundId) {
        return new Response(JSON.stringify({ error: "round_id requerido" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const user = await locals.getUser();
    if (!user) {
        return new Response(JSON.stringify({ error: "No autenticado" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }

    const supabase = locals.supabase;

    // Verificar que sea staff (admin o docente)
    const { data: profile } = await supabase
        .from("players")
        .select("role")
        .eq("auth_user_id", user.id)
        .single();

    if (profile?.role !== "admin" && profile?.role !== "docente" && profile?.role !== "preseleccion") {
        return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    const roundIdNum = parseInt(roundId, 10);
    const effectiveRoundId = Number.isFinite(roundIdNum) ? roundIdNum : parseInt(String(roundId), 10);
    const { data: round } = await supabaseAdmin
        .from("event_rounds")
        .select("id, event_id, classroom_group_id, current_question_id, status, events(game_mode_id)")
        .eq("id", effectiveRoundId)
        .single();

    if (!round) {
        return new Response(JSON.stringify({ error: "Ronda no encontrada" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    }

    // Rol preseleccion: solo puede ver datos de rondas de Preselección
    const gameModeId = (round?.events as { game_mode_id?: number })?.game_mode_id;
    if (profile?.role === "preseleccion" && gameModeId !== 1) {
        return new Response(JSON.stringify({ error: "Tu rol solo permite ver Preselección" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    const result: {
        connected: { player_id: number; name: string }[];
        responders: { player_id: number; name: string; response_time_ms?: number; is_correct?: boolean }[];
        current_question_id: number | null;
        status: string;
        fastest_finger_attempts?: { player_id: number; name: string; response_time_ms: number; is_correct: boolean }[];
        student_selection?: { player_id: number; name: string; answer_id: number; answer_text: string; letter: string } | null;
        last_word_used?: boolean;
        current_question?: {
            id: number;
            question_text: string;
            level_id: number | null;
            level_name: string | null;
            answers: { id: number; answer_text: string; letter: string; is_correct: boolean }[];
        } | null;
    } = {
        connected: [],
        responders: [],
        current_question_id: round.current_question_id,
        status: round.status || "waiting",
    };

    // Si es Mente más Rápida, traer intentos (sin embed; nombres en consulta aparte)
    if (round.status === "fastest_finger") {
        const { attempts } = await loadFastestFingerAttempts(supabaseAdmin, effectiveRoundId);
        result.fastest_finger_attempts = attempts;
    }

    // Última palabra usada en la pregunta actual (Clásico)
    if (round.status === "active" && round.current_question_id && (round?.events as { game_mode_id?: number })?.game_mode_id === 2) {
        const { data: lw } = await supabaseAdmin
            .from("round_lifeline_usage")
            .select("id")
            .eq("round_id", effectiveRoundId)
            .eq("question_id", round.current_question_id)
            .eq("lifeline_code", "last_word")
            .maybeSingle();
        result.last_word_used = !!lw;
    }

    // Conectados: SOLO quienes tienen sesión activa en ESTA ronda (entraron con el PIN de esta sala).
    // No usar event_players del evento: incluiría a quien entró en otra ronda/canal anterior.
    const playerIds = new Set<number>();
    const { data: sessions } = await supabaseAdmin
        .from("game_sessions")
        .select("player_id")
        .eq("round_id", effectiveRoundId)
        .eq("finished", false);
    if (sessions) sessions.forEach((s) => s.player_id && playerIds.add(s.player_id));

    if (playerIds.size > 0) {
        const { data: players } = await supabaseAdmin
            .from("players")
            .select("id, name")
            .in("id", [...playerIds]);
        const nameMap = new Map((players || []).map((p) => [p.id, p.name || "Estudiante"]));
        result.connected = [...playerIds].map((id) => ({
            player_id: id,
            name: nameMap.get(id) || "Estudiante",
        }));
    }

    // Si está activo y hay pregunta: selección del estudiante (Clásico) o quienes respondieron
    if (round.status === "active" && round.current_question_id) {
        const isClasico = (round?.events as { game_mode_id?: number })?.game_mode_id === 2;

        if (isClasico) {
            result.current_question = await loadClasicoCurrentQuestion(
                supabaseAdmin,
                effectiveRoundId,
                round.current_question_id
            );

            const { data: sel } = await supabaseAdmin
                .from("student_answer_selection")
                .select("player_id, answer_id, players(name)")
                .eq("round_id", effectiveRoundId)
                .eq("question_id", round.current_question_id)
                .limit(1);
            if (sel && sel.length > 0) {
                const s = sel[0];
                const { data: ans } = await supabaseAdmin.from("answers").select("answer_text").eq("id", s.answer_id).single();
                const { data: ansList } = await supabaseAdmin.from("answers").select("id").eq("question_id", round.current_question_id).order("id");
                const shuffled = seededShuffle(ansList || [], parseInt(roundId, 10) * 31 + (round.current_question_id || 0));
                const idx = shuffled.findIndex((a: { id: number }) => a.id === s.answer_id);
                const letter = ["A", "B", "C", "D"][idx >= 0 ? idx : 0];
                result.student_selection = {
                    player_id: s.player_id,
                    name: (s.players as { name?: string })?.name || "Estudiante",
                    answer_id: s.answer_id,
                    answer_text: ans?.answer_text || "",
                    letter,
                };
            }
        }
        if (!isClasico) {
        const roundIdNum = parseInt(roundId, 10);
        const { data: answers } = await supabaseAdmin
            .from("game_answers")
            .select("player_id, response_time_ms, is_correct, players(name)")
            .eq("question_id", round.current_question_id)
            .eq("round_id", isNaN(roundIdNum) ? roundId : roundIdNum);

        if (answers) {
            const seen = new Set<number>();
            result.responders = answers
                .filter((a) => a.player_id && !seen.has(a.player_id) && seen.add(a.player_id))
                .map((a) => ({
                    player_id: a.player_id,
                    name: (a.players as { name?: string } | null)?.name || "Estudiante",
                    response_time_ms: a.response_time_ms,
                    is_correct: a.is_correct,
                }));
        }
        }
    }

    return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
};
