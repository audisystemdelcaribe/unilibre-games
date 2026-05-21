import type { APIRoute } from "astro";
import { buildClasicoRoundMeta } from "@/lib/clasicoRoundContestant";
import {
    findClasicoEventForScope,
    resolveRoundEvent,
    setupClasicoWinner,
} from "@/lib/clasicoTransition";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * POST: Confirmar ganador de Mente más Rápida y crear ronda de Silla Caliente.
 * Devuelve clasico_round_id para redirigir al panel de control.
 */
export const POST: APIRoute = async ({ request, locals }) => {
    const user = await locals.getUser();
    if (!user) {
        return new Response(JSON.stringify({ error: "No autenticado" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }

    const { data: profile } = await locals.supabase
        .from("players")
        .select("role")
        .eq("auth_user_id", user.id)
        .single();

    if (profile?.role !== "admin" && profile?.role !== "docente" && profile?.role !== "preseleccion") {
        return new Response(JSON.stringify({ error: "Solo staff puede confirmar ganador" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    let body: { round_id: string; player_id: string };
    try {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            body = await request.json();
        } else {
            const formData = await request.formData();
            body = {
                round_id: String(formData.get("round_id") ?? ""),
                player_id: String(formData.get("player_id") ?? ""),
            };
        }
    } catch {
        return new Response(JSON.stringify({ error: "Body inválido" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const { round_id, player_id } = body;
    const rId = parseInt(round_id, 10);
    const pId = parseInt(player_id, 10);

    if (!round_id || !player_id || isNaN(rId) || isNaN(pId)) {
        return new Response(
            JSON.stringify({ error: "round_id y player_id válidos son requeridos. Asegúrate de seleccionar un ganador." }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    const { data: round } = await supabaseAdmin
        .from("event_rounds")
        .select("event_id, events(season_id, program_id, faculty_id, scope)")
        .eq("id", rId)
        .single();

    if (!round) {
        return new Response(JSON.stringify({ error: "Ronda no encontrada" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    }

    const evt = resolveRoundEvent(round.events);
    if (!evt?.season_id) {
        return new Response(JSON.stringify({ error: "No se pudo obtener la temporada del evento" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const clasicoEvent = await findClasicoEventForScope(supabaseAdmin, evt);

    if (!clasicoEvent) {
        const scopeHint =
            evt?.scope === "program" ? " y mismo programa" : evt?.scope === "faculty" ? " y misma facultad" : "";
        return new Response(
            JSON.stringify({
                error: `No hay evento Clásico (Silla Caliente) para esta temporada${scopeHint}. Crea uno en Eventos con modo Clásico.`,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    const session_pin = Math.floor(1000 + Math.random() * 9000).toString();
    const { data: clasicoRound, error: roundErr } = await supabaseAdmin
        .from("event_rounds")
        .insert([
            {
                event_id: clasicoEvent.id,
                round_number: 0,
                type: "classroom_quiz",
                status: "waiting",
                classroom_group_id: "Silla Caliente",
                session_pin,
                verification_result: buildClasicoRoundMeta(pId, rId),
            },
        ])
        .select()
        .single();

    if (roundErr) {
        return new Response(JSON.stringify({ error: roundErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        await setupClasicoWinner(supabaseAdmin, {
            playerId: pId,
            clasicoEventId: clasicoEvent.id,
            clasicoRoundId: clasicoRound.id,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : "Error al registrar al ganador";
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }

    await supabaseAdmin.from("event_rounds").update({ status: "finished" }).eq("id", rId);

    return new Response(
        JSON.stringify({
            success: true,
            message: "Ganador confirmado. El concursante puede entrar en Silla Caliente.",
            clasico_round_id: clasicoRound.id,
            clasico_pin: session_pin,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
    );
};
