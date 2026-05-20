import type { APIRoute } from "astro";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
    formatFastestTimeMs,
    getProvisionalWinner,
    loadFastestFingerAttempts,
} from "@/lib/fastestFingerResults";

/**
 * Estado de Mente más Rápida para el jugador: tiempo, ganador provisional y confirmación (Silla Caliente).
 */
export const GET: APIRoute = async ({ url, locals }) => {
    const empty = {
        round_status: null as string | null,
        finished: false,
        isWinner: false,
        is_provisional_winner: false,
        my_time_ms: null as number | null,
        my_time_sec: null as string | null,
        my_correct: false,
        provisional_winner_name: null as string | null,
    };

    const user = await locals.getUser();
    if (!user) {
        return json(empty);
    }

    const roundId = url.searchParams.get("round_id");
    if (!roundId) {
        return json(empty);
    }

    const rId = parseInt(roundId, 10);
    if (!Number.isFinite(rId)) {
        return json(empty);
    }

    const { data: player } = await supabaseAdmin
        .from("players")
        .select("id")
        .eq("auth_user_id", user.id)
        .single();

    if (!player?.id) {
        return json(empty);
    }

    const { data: round } = await supabaseAdmin
        .from("event_rounds")
        .select("status, event_id, events(season_id, program_id, faculty_id, scope)")
        .eq("id", rId)
        .single();

    if (!round) {
        return json(empty);
    }

    const { attempts } = await loadFastestFingerAttempts(supabaseAdmin, rId);
    const mine = attempts.find((a) => a.player_id === player.id);
    const provisional = getProvisionalWinner(attempts);

    const base = {
        round_status: round.status,
        finished: round.status === "finished",
        isWinner: false,
        is_provisional_winner: !!provisional && provisional.player_id === player.id,
        my_time_ms: mine?.response_time_ms ?? null,
        my_time_sec: mine != null ? formatFastestTimeMs(mine.response_time_ms) : null,
        my_correct: !!mine?.is_correct,
        provisional_winner_name: provisional?.name ?? null,
    };

    if (round.status !== "finished") {
        return json(base);
    }

    const evt = round.events as {
        season_id?: number;
        program_id?: number | null;
        faculty_id?: number | null;
        scope?: string;
    };
    const seasonId = evt?.season_id;
    if (!seasonId) {
        return json({ ...base, finished: true });
    }

    let clasicoQuery = supabaseAdmin
        .from("events")
        .select("id")
        .eq("season_id", seasonId)
        .eq("game_mode_id", 2);

    if (evt?.scope === "program" && evt?.program_id) {
        clasicoQuery = clasicoQuery.eq("program_id", evt.program_id).eq("scope", "program");
    } else if (evt?.scope === "faculty" && evt?.faculty_id) {
        clasicoQuery = clasicoQuery.eq("faculty_id", evt.faculty_id).eq("scope", "faculty");
    } else {
        clasicoQuery = clasicoQuery.eq("scope", evt?.scope || "global");
    }

    const { data: clasicoEvent } = await clasicoQuery.limit(1).maybeSingle();

    if (!clasicoEvent) {
        return json({ ...base, finished: true });
    }

    const { data: ac } = await supabaseAdmin
        .from("active_contestants")
        .select("player_id")
        .eq("event_id", clasicoEvent.id)
        .maybeSingle();

    const isWinner = ac?.player_id === player.id;

    return json({
        ...base,
        finished: true,
        isWinner,
        is_provisional_winner: isWinner || base.is_provisional_winner,
    });
};

function json(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}
