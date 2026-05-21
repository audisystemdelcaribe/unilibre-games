import type { SupabaseClient } from "@supabase/supabase-js";

export type RoundEventScope = {
    season_id?: number;
    program_id?: number | null;
    faculty_id?: number | null;
    scope?: string;
};

/** PostgREST puede devolver `events` como objeto o como array de un elemento. */
export function resolveRoundEvent(events: unknown): RoundEventScope | null {
    if (!events) return null;
    const ev = Array.isArray(events) ? events[0] : events;
    if (!ev || typeof ev !== "object") return null;
    return ev as RoundEventScope;
}

/** Evento Clásico (Silla Caliente) con la misma temporada y ámbito que la ronda de referencia. */
export async function findClasicoEventForScope(
    supabase: SupabaseClient,
    evt: RoundEventScope | null
): Promise<{ id: number } | null> {
    const seasonId = evt?.season_id;
    if (!seasonId) return null;

    let q = supabase.from("events").select("id").eq("season_id", seasonId).eq("game_mode_id", 2);

    if (evt?.scope === "program" && evt.program_id) {
        q = q.eq("program_id", evt.program_id).eq("scope", "program");
    } else if (evt?.scope === "faculty" && evt.faculty_id) {
        q = q.eq("faculty_id", evt.faculty_id).eq("scope", "faculty");
    } else {
        q = q.eq("scope", evt?.scope || "global");
    }

    const { data } = await q.limit(1).maybeSingle();
    return data;
}

/** Inscribe al ganador en Silla Caliente: event_players, active_contestants y sesión de juego. */
export async function setupClasicoWinner(
    supabase: SupabaseClient,
    opts: { playerId: number; clasicoEventId: number; clasicoRoundId: number }
): Promise<void> {
    const { playerId, clasicoEventId, clasicoRoundId } = opts;

    const { error: epErr } = await supabase.from("event_players").upsert(
        {
            event_id: clasicoEventId,
            player_id: playerId,
            classroom_group_id: "Silla Caliente",
            stage: "lobby",
        },
        { onConflict: "event_id, player_id" }
    );
    if (epErr) throw new Error(epErr.message);

    const { error: acErr } = await supabase.from("active_contestants").upsert(
        { event_id: clasicoEventId, player_id: playerId, round_id: clasicoRoundId },
        { onConflict: "event_id" }
    );
    if (acErr) throw new Error(acErr.message);

    const payload = {
        player_id: playerId,
        event_id: clasicoEventId,
        round_id: clasicoRoundId,
        session_type: "classroom" as const,
        finished: false,
    };
    const { error: sErr } = await supabase
        .from("game_sessions")
        .upsert(payload, { onConflict: "player_id, event_id, finished" });

    if (sErr && /duplicate key|unique/i.test(sErr.message)) {
        const { error: upErr } = await supabase
            .from("game_sessions")
            .update({ finished: false, round_id: clasicoRoundId, session_type: "classroom" })
            .eq("player_id", playerId)
            .eq("event_id", clasicoEventId)
            .eq("finished", true);
        if (upErr) {
            await supabase
                .from("game_sessions")
                .update({ round_id: clasicoRoundId, session_type: "classroom" })
                .eq("player_id", playerId)
                .eq("event_id", clasicoEventId)
                .eq("finished", false);
        }
    } else if (sErr) {
        throw new Error(sErr.message);
    }

    await supabase
        .from("game_sessions")
        .update({ round_id: clasicoRoundId, finished: false })
        .eq("player_id", playerId)
        .eq("event_id", clasicoEventId)
        .eq("finished", false);
}
