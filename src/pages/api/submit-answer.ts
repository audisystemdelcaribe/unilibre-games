import type { APIRoute } from "astro";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertQuestionMatchesEventScope, type EventScope } from "@/lib/questionScope";

/**
 * API para enviar respuesta en preselección (game_mode_id=1).
 * Alternativa fiable a la acción submitAnswer para evitar problemas con la API de acciones en el cliente.
 */
export const POST: APIRoute = async ({ request, locals }) => {
    const user = await locals.getUser();
    if (!user) {
        return new Response(JSON.stringify({ error: "Debes iniciar sesión" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }

    let input: { round_id: string; question_id: string; answer_id: string; session_id: string };
    try {
        const formData = await request.formData();
        input = {
            round_id: String(formData.get("round_id") ?? ""),
            question_id: String(formData.get("question_id") ?? ""),
            answer_id: String(formData.get("answer_id") ?? ""),
            session_id: String(formData.get("session_id") ?? ""),
        };
    } catch {
        return new Response(JSON.stringify({ error: "Body inválido" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const { round_id, question_id, answer_id, session_id } = input;
    if (!round_id || !question_id || !answer_id || !session_id) {
        return new Response(
            JSON.stringify({ error: "round_id, question_id, answer_id y session_id requeridos" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    const sessionIdNum = parseInt(session_id, 10);
    if (isNaN(sessionIdNum)) {
        return new Response(JSON.stringify({ error: "Sesión inválida. Vuelve a unirte con el PIN." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const now = Date.now();

    const [roundRes, questionRes, answerRes, playerRes] = await Promise.all([
        supabaseAdmin.from("event_rounds").select("*, events(game_mode_id, scope, program_id, faculty_id)").eq("id", parseInt(round_id)).single(),
        supabaseAdmin.from("questions").select("*, game_levels(points, time_limit), scope, program_id, faculty_id").eq("id", parseInt(question_id)).single(),
        supabaseAdmin.from("answers").select("is_correct, question_id").eq("id", parseInt(answer_id)).single(),
        supabaseAdmin.from("players").select("id").eq("auth_user_id", user.id).single(),
    ]);

    if (!roundRes.data) {
        return new Response(JSON.stringify({ error: "Ronda no encontrada" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (!roundRes.data.question_started_at) {
        return new Response(JSON.stringify({ error: "Pregunta no iniciada" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const qId = parseInt(question_id);
    if (!answerRes.data) {
        return new Response(JSON.stringify({ error: "Respuesta no encontrada" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (answerRes.data.question_id !== qId) {
        return new Response(JSON.stringify({ error: "Respuesta inválida para esta pregunta" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (roundRes.data.current_question_id !== qId) {
        return new Response(JSON.stringify({ error: "Esta pregunta ya no está activa" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (!questionRes.data) {
        return new Response(JSON.stringify({ error: "Pregunta no encontrada" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const gameModeId = (roundRes.data?.events as { game_mode_id?: number })?.game_mode_id;
    try {
        assertQuestionMatchesEventScope(
            questionRes.data,
            roundRes.data.events as EventScope,
            gameModeId
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : "Pregunta no válida para este evento";
        return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const startTime = new Date(roundRes.data.question_started_at).getTime();
    const responseMs = now - startTime;
    const limitMs = (gameModeId === 1 ? 30 : ((questionRes.data?.game_levels as { time_limit?: number })?.time_limit ?? 30)) * 1000;
    const isCorrect = answerRes.data.is_correct ?? false;

    const { data: gameSession } = await supabaseAdmin
        .from("game_sessions")
        .select("id, player_id, event_id")
        .eq("id", sessionIdNum)
        .single();

    if (!playerRes.data?.id) {
        return new Response(JSON.stringify({ error: "Jugador no encontrado" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (!gameSession || gameSession.player_id !== playerRes.data.id) {
        return new Response(JSON.stringify({ error: "Sesión de juego inválida" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (gameSession.event_id !== roundRes.data.event_id) {
        return new Response(JSON.stringify({ error: "La sesión no corresponde a esta ronda" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    // Idempotencia: si ya respondió esta pregunta, retornar éxito sin volver a insertar
    const { data: existingAnswer } = await supabaseAdmin
        .from("game_answers")
        .select("id, is_correct, money_at_question")
        .eq("game_session_id", sessionIdNum)
        .eq("question_id", qId)
        .maybeSingle();

    if (existingAnswer) {
        return new Response(
            JSON.stringify({
                success: true,
                correct: existingAnswer.is_correct ?? false,
                points: existingAnswer.money_at_question ?? 0,
                time: (responseMs / 1000).toFixed(2),
                insertId: existingAnswer.id,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    }

    const isJuegoFinal = (roundRes.data.events as { game_mode_id?: number })?.game_mode_id === 2;
    let points = 0;
    if (isCorrect) {
        const base = (questionRes.data?.game_levels as { points?: number })?.points ?? 1000;
        if (isJuegoFinal) {
            points = base;
        } else {
            const ratio = Math.max(0, (limitMs - responseMs) / limitMs);
            points = Math.round(base * (0.05 + ratio * 0.95));
        }
    }

    await supabaseAdmin.from("event_players").upsert(
        {
            event_id: roundRes.data.event_id,
            player_id: playerRes.data.id,
            classroom_group_id: roundRes.data.classroom_group_id ?? "",
            stage: "playing",
        },
        { onConflict: "event_id, player_id" }
    );

    const levelId =
        (questionRes.data as { level_id?: number })?.level_id ??
        (questionRes.data?.game_levels as { id?: number })?.id ??
        1;

    const { data: insertedId, error: insertErr } = await supabaseAdmin.rpc("insert_game_answer", {
        p_game_session_id: sessionIdNum,
        p_round_id: parseInt(round_id, 10),
        p_event_id: roundRes.data.event_id,
        p_player_id: playerRes.data.id,
        p_classroom_group_id: roundRes.data.classroom_group_id ?? "",
        p_question_id: parseInt(question_id, 10),
        p_answer_id: parseInt(answer_id, 10),
        p_is_correct: isCorrect,
        p_response_time_ms: responseMs,
        p_money_at_question: points,
        p_level_id: typeof levelId === "number" ? levelId : parseInt(String(levelId), 10) || 1,
    });

    if (insertErr) {
        console.error("[submit-answer] insert_game_answer falló:", insertErr);
        return new Response(
            JSON.stringify({ error: `Error al guardar respuesta: ${insertErr.message}` }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }

    if (points > 0) {
        await supabaseAdmin.rpc("registrar_puntaje_ganado", {
            p_session_id: sessionIdNum,
            p_event_id: roundRes.data.event_id,
            p_player_id: playerRes.data.id,
            p_puntos: points,
        });
    }

    await supabaseAdmin.rpc("add_player_time", {
        p_player_id: playerRes.data.id,
        p_event_id: roundRes.data.event_id,
        p_response_ms: responseMs,
    });

    const data = {
        success: true,
        correct: isCorrect,
        points,
        time: (responseMs / 1000).toFixed(2),
        insertId: insertedId ?? null,
    };

    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
};
