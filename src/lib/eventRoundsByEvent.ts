import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveContestantNamesForClasicoRounds } from "./clasicoRoundContestant";
import { statusLabel } from "./launchedSessionsHistory";

export type EventRoundSummary = {
    roundId: number;
    sessionPin: string;
    classroomGroupId: string;
    status: string;
    sortTime: string | null;
    createdAt: string | null;
    participantCount: number;
    /** Silla Caliente: ganador que debe jugar en esta ronda */
    contestantName: string | null;
};

export type EventWithRounds = {
    eventId: number;
    eventName: string;
    gameModeId: number;
    gameModeName: string;
    seasonName: string;
    scope: string;
    eventDate: string | null;
    rounds: EventRoundSummary[];
};

export type LoadRoundsByEventOptions = {
    page: number;
    pageSize: number;
    seasonId?: number | null;
    gameModeId?: number | null;
    preseleccionOnly?: boolean;
    eventId?: number | null;
};

export type LoadRoundsByEventResult = {
    events: EventWithRounds[];
    totalCount: number;
};

type EventRow = {
    id: number;
    name: string;
    scope: string | null;
    event_date: string | null;
    game_mode_id: number;
    season_id: number | null;
    seasons: { name: string } | null;
    game_modes: { name: string } | null;
};

type RoundRow = {
    id: number;
    event_id: number;
    session_pin: string | null;
    classroom_group_id: string | null;
    status: string | null;
    question_started_at: string | null;
    created_at: string | null;
    verification_result: unknown;
};

function sessionKey(eventId: number, groupId: string) {
    return `${eventId}::${groupId}`;
}

export async function loadRoundsGroupedByEvent(
    supabase: SupabaseClient,
    options: LoadRoundsByEventOptions
): Promise<LoadRoundsByEventResult> {
    const { page, pageSize, seasonId, gameModeId, preseleccionOnly, eventId } = options;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let eventsQ = supabase
        .from("events")
        .select(
            "id, name, scope, event_date, game_mode_id, season_id, seasons(name), game_modes(name)",
            { count: "exact" }
        )
        .order("event_date", { ascending: false })
        .order("id", { ascending: false });

    if (seasonId) eventsQ = eventsQ.eq("season_id", seasonId);
    if (gameModeId) eventsQ = eventsQ.eq("game_mode_id", gameModeId);
    else if (preseleccionOnly) eventsQ = eventsQ.eq("game_mode_id", 1);
    if (eventId) eventsQ = eventsQ.eq("id", eventId);

    const { data: eventRows, count: totalCount } = await eventsQ.range(from, to);
    const events = (eventRows || []) as EventRow[];
    if (!events.length) {
        return { events: [], totalCount: totalCount ?? 0 };
    }

    const eventIds = events.map((e) => e.id);

    const { data: rounds } = await supabase
        .from("event_rounds")
        .select(
            "id, event_id, session_pin, classroom_group_id, status, question_started_at, created_at, verification_result"
        )
        .in("event_id", eventIds)
        .order("id", { ascending: false });

    const roundRows = (rounds || []) as RoundRow[];
    const roundIds = roundRows.map((r) => r.id);

    const participantCountByRound = new Map<number, number>();
    const participantCountBySession = new Map<string, Set<number>>();

    if (roundIds.length > 0) {
        const { data: gameSessions } = await supabase
            .from("game_sessions")
            .select("round_id, player_id")
            .in("round_id", roundIds);

        const gsSets = new Map<number, Set<number>>();
        for (const gs of gameSessions || []) {
            const row = gs as { round_id: number; player_id: number };
            if (!row.round_id) continue;
            if (!gsSets.has(row.round_id)) gsSets.set(row.round_id, new Set());
            gsSets.get(row.round_id)!.add(row.player_id);
        }
        for (const [rid, set] of gsSets) {
            participantCountByRound.set(rid, set.size);
        }
    }

    const { data: eventPlayers } = await supabase
        .from("event_players")
        .select("event_id, player_id, classroom_group_id")
        .in("event_id", eventIds);

    for (const ep of eventPlayers || []) {
        const row = ep as {
            event_id: number;
            player_id: number;
            classroom_group_id: string | null;
        };
        const key = sessionKey(row.event_id, row.classroom_group_id ?? "");
        if (!participantCountBySession.has(key)) {
            participantCountBySession.set(key, new Set());
        }
        participantCountBySession.get(key)!.add(row.player_id);
    }

    const clasicoEventIds = events.filter((e) => e.game_mode_id === 2).map((e) => e.id);
    const activeContestantPlayerByRoundId = new Map<number, number>();

    if (clasicoEventIds.length > 0) {
        const { data: activeContestants } = await supabase
            .from("active_contestants")
            .select("event_id, round_id, player_id")
            .in("event_id", clasicoEventIds);

        for (const ac of activeContestants || []) {
            const row = ac as { round_id: number | null; player_id: number };
            if (row.round_id != null) activeContestantPlayerByRoundId.set(row.round_id, row.player_id);
        }
    }

    const contestantNameByRoundId = new Map<number, string>();
    for (const eventId of clasicoEventIds) {
        const ev = events.find((e) => e.id === eventId);
        const evRounds = roundRows.filter((r) => r.event_id === eventId);
        const names = await resolveContestantNamesForClasicoRounds(
            supabase,
            evRounds.map((r) => ({ id: r.id, verification_result: r.verification_result })),
            activeContestantPlayerByRoundId,
            ev?.season_id ?? null
        );
        for (const [rid, name] of names) contestantNameByRoundId.set(rid, name);
    }

    const roundsByEvent = new Map<number, EventRoundSummary[]>();
    const gameModeByEventId = new Map(events.map((e) => [e.id, e.game_mode_id]));

    for (const r of roundRows) {
        const groupId = r.classroom_group_id ?? "";
        const key = sessionKey(r.event_id, groupId);
        const fromSessions = participantCountByRound.get(r.id) ?? 0;
        const fromEp = participantCountBySession.get(key)?.size ?? 0;
        const isClasico = gameModeByEventId.get(r.event_id) === 2;
        const summary: EventRoundSummary = {
            roundId: r.id,
            sessionPin: r.session_pin || "—",
            classroomGroupId: groupId || "—",
            status: r.status || "waiting",
            sortTime: r.question_started_at,
            createdAt: r.created_at,
            participantCount: Math.max(fromSessions, fromEp),
            contestantName: isClasico ? contestantNameByRoundId.get(r.id) ?? null : null,
        };
        if (!roundsByEvent.has(r.event_id)) roundsByEvent.set(r.event_id, []);
        roundsByEvent.get(r.event_id)!.push(summary);
    }

    const result: EventWithRounds[] = events.map((e) => ({
        eventId: e.id,
        eventName: e.name,
        gameModeId: e.game_mode_id,
        gameModeName: e.game_modes?.name || "—",
        seasonName: e.seasons?.name || "—",
        scope: e.scope || "global",
        eventDate: e.event_date,
        rounds: roundsByEvent.get(e.id) || [],
    }));

    return { events: result, totalCount: totalCount ?? 0 };
}

export { statusLabel };

export function scopeLabel(scope: string): string {
    if (scope === "program") return "Programa";
    if (scope === "faculty") return "Facultad";
    if (scope === "global") return "Global";
    return scope;
}
