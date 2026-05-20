import type { SupabaseClient } from "@supabase/supabase-js";
import {
    formatFastestTimeMs,
    getProvisionalWinner,
    loadFastestFingerAttempts,
} from "./fastestFingerResults";

export type SessionParticipant = {
    player_id: number;
    name: string;
    score: number;
    total_time_ms: number | null;
    is_finalist: boolean;
    is_winner: boolean;
    rank: number;
};

export type LaunchedSessionRow = {
    roundId: number;
    eventId: number;
    eventName: string;
    gameModeId: number;
    gameModeName: string;
    seasonName: string;
    classroomGroupId: string;
    sessionPin: string;
    status: string;
    sortTime: string | null;
    participants: SessionParticipant[];
};

type RoundRow = {
    id: number;
    event_id: number;
    session_pin: string | null;
    classroom_group_id: string | null;
    status: string | null;
    question_started_at: string | null;
    events: {
        id: number;
        name: string;
        game_mode_id: number;
        season_id: number | null;
        seasons: { name: string } | null;
        game_modes: { name: string } | null;
    } | null;
};

export type LoadHistoryOptions = {
    page: number;
    pageSize: number;
    seasonId?: number | null;
    gameModeId?: number | null;
    preseleccionOnly?: boolean;
};

export type LoadHistoryResult = {
    sessions: LaunchedSessionRow[];
    totalCount: number;
};

function sessionKey(eventId: number, groupId: string) {
    return `${eventId}::${groupId}`;
}

function compareParticipants(
    a: { score: number; total_time_ms: number | null; player_id: number },
    b: { score: number; total_time_ms: number | null; player_id: number }
) {
    if (b.score !== a.score) return b.score - a.score;
    const ta = a.total_time_ms ?? Number.MAX_SAFE_INTEGER;
    const tb = b.total_time_ms ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.player_id - b.player_id;
}

function resolveWinnerPlayerId(
    gameModeId: number,
    status: string | null,
    participants: SessionParticipant[],
    ffWinnerId: number | null,
    activeContestantId: number | null
): number | null {
    if (status === "fastest_finger" || gameModeId === 3) {
        if (ffWinnerId) return ffWinnerId;
    }
    if (gameModeId === 2 && activeContestantId) {
        return activeContestantId;
    }
    const finalist = participants.find((p) => p.is_finalist);
    if (finalist) return finalist.player_id;
    if (gameModeId === 1 && participants.length > 0) {
        return participants[0].player_id;
    }
    if (ffWinnerId) return ffWinnerId;
    return null;
}

export async function loadLaunchedSessionsHistory(
    supabase: SupabaseClient,
    options: LoadHistoryOptions
): Promise<LoadHistoryResult> {
    const { page, pageSize, seasonId, gameModeId, preseleccionOnly } = options;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let eventIdsFilter: number[] | null = null;
    if (seasonId || gameModeId || preseleccionOnly) {
        let evQ = supabase.from("events").select("id");
        if (seasonId) evQ = evQ.eq("season_id", seasonId);
        if (gameModeId) evQ = evQ.eq("game_mode_id", gameModeId);
        else if (preseleccionOnly) evQ = evQ.eq("game_mode_id", 1);
        const { data: evs } = await evQ;
        eventIdsFilter = (evs || []).map((e: { id: number }) => e.id);
        if (eventIdsFilter.length === 0) {
            return { sessions: [], totalCount: 0 };
        }
    }

    let roundsQ = supabase
        .from("event_rounds")
        .select(
            "id, event_id, session_pin, classroom_group_id, status, question_started_at, events(id, name, game_mode_id, season_id, seasons(name), game_modes(name))",
            { count: "exact" }
        )
        .order("id", { ascending: false });

    if (eventIdsFilter) {
        roundsQ = roundsQ.in("event_id", eventIdsFilter);
    }

    const { data: rounds, count: totalCount } = await roundsQ.range(from, to);
    const roundRows = (rounds || []) as RoundRow[];
    if (!roundRows.length) {
        return { sessions: [], totalCount: totalCount ?? 0 };
    }

    const roundIds = roundRows.map((r) => r.id);
    const eventIds = [...new Set(roundRows.map((r) => r.event_id))];

    const [{ data: gameSessions }, { data: eventPlayers }, { data: activeContestants }] =
        await Promise.all([
            supabase
                .from("game_sessions")
                .select("player_id, score, round_id, players(id, name)")
                .in("round_id", roundIds),
            supabase
                .from("event_players")
                .select(
                    "player_id, score, total_time_ms, is_finalist, event_id, classroom_group_id, players(id, name)"
                )
                .in("event_id", eventIds),
            supabase.from("active_contestants").select("event_id, player_id").in("event_id", eventIds),
        ]);

    const acByEvent = new Map(
        (activeContestants || []).map((ac: { event_id: number; player_id: number }) => [
            ac.event_id,
            ac.player_id,
        ])
    );

    const epBySession = new Map<string, typeof eventPlayers>();
    for (const ep of eventPlayers || []) {
        const row = ep as {
            event_id: number;
            classroom_group_id: string | null;
        };
        const key = sessionKey(row.event_id, row.classroom_group_id ?? "");
        if (!epBySession.has(key)) epBySession.set(key, []);
        epBySession.get(key)!.push(ep);
    }

    const gsByRound = new Map<number, typeof gameSessions>();
    for (const gs of gameSessions || []) {
        const row = gs as { round_id: number };
        if (!gsByRound.has(row.round_id)) gsByRound.set(row.round_id, []);
        gsByRound.get(row.round_id)!.push(gs);
    }

    const ffWinnerByRound = new Map<number, number | null>();
    const ffStartedByRound = new Map<number, string | null>();
    await Promise.all(
        roundRows.map(async (round) => {
            const gm = round.events?.game_mode_id ?? 0;
            const needsFf =
                gm === 3 || round.status === "fastest_finger" || round.status === "finished";
            if (!needsFf) {
                ffWinnerByRound.set(round.id, null);
                return;
            }
            const { attempts } = await loadFastestFingerAttempts(supabase, round.id);
            const winner = getProvisionalWinner(attempts);
            ffWinnerByRound.set(round.id, winner?.player_id ?? null);

            const { data: ffRound } = await supabase
                .from("fastest_finger_rounds")
                .select("started_at")
                .eq("event_round_id", round.id)
                .maybeSingle();
            ffStartedByRound.set(round.id, (ffRound as { started_at?: string } | null)?.started_at ?? null);
        })
    );

    const sessions: LaunchedSessionRow[] = roundRows.map((round) => {
        const groupId = round.classroom_group_id ?? "";
        const gameModeId = round.events?.game_mode_id ?? 0;
        const key = sessionKey(round.event_id, groupId);

        type EP = {
            player_id: number;
            score: number;
            total_time_ms: number | null;
            is_finalist: boolean;
            players: { id: number; name: string } | null;
        };
        type GS = {
            player_id: number;
            score: number;
            players: { id: number; name: string } | null;
        };

        const epList = (epBySession.get(key) || []) as EP[];
        const gsList = (gsByRound.get(round.id) || []) as GS[];

        const playerMap = new Map<
            number,
            { name: string; score: number; total_time_ms: number | null; is_finalist: boolean }
        >();

        for (const ep of epList) {
            playerMap.set(ep.player_id, {
                name: ep.players?.name || "Estudiante",
                score: ep.score ?? 0,
                total_time_ms: ep.total_time_ms,
                is_finalist: !!ep.is_finalist,
            });
        }

        for (const gs of gsList) {
            const existing = playerMap.get(gs.player_id);
            playerMap.set(gs.player_id, {
                name: gs.players?.name || existing?.name || "Estudiante",
                score: Math.max(gs.score ?? 0, existing?.score ?? 0),
                total_time_ms: existing?.total_time_ms ?? null,
                is_finalist: existing?.is_finalist ?? false,
            });
        }

        let participants: SessionParticipant[] = [...playerMap.entries()]
            .map(([player_id, p]) => ({
                player_id,
                name: p.name,
                score: p.score,
                total_time_ms: p.total_time_ms,
                is_finalist: p.is_finalist,
                is_winner: false,
                rank: 0,
            }))
            .sort(compareParticipants);

        const winnerId = resolveWinnerPlayerId(
            gameModeId,
            round.status,
            participants,
            ffWinnerByRound.get(round.id) ?? null,
            acByEvent.get(round.event_id) ?? null
        );

        participants = participants.map((p, i) => ({
            ...p,
            rank: i + 1,
            is_winner: winnerId != null && p.player_id === winnerId,
        }));

        const sortTime =
            round.question_started_at ||
            ffStartedByRound.get(round.id) ||
            null;

        return {
            roundId: round.id,
            eventId: round.event_id,
            eventName: round.events?.name || "—",
            gameModeId,
            gameModeName: round.events?.game_modes?.name || "—",
            seasonName: round.events?.seasons?.name || "—",
            classroomGroupId: groupId,
            sessionPin: round.session_pin || "—",
            status: round.status || "waiting",
            sortTime,
            participants,
        };
    });

    sessions.sort((a, b) => {
        const ta = a.sortTime ? new Date(a.sortTime).getTime() : 0;
        const tb = b.sortTime ? new Date(b.sortTime).getTime() : 0;
        if (tb !== ta) return tb - ta;
        return b.roundId - a.roundId;
    });

    return { sessions, totalCount: totalCount ?? 0 };
}

export function formatParticipantTime(ms: number | null | undefined): string {
    return formatFastestTimeMs(ms);
}

export function statusLabel(status: string): string {
    const map: Record<string, string> = {
        waiting: "En espera",
        active: "En juego",
        fastest_finger: "Mente más Rápida",
        finished: "Finalizada",
    };
    return map[status] || status;
}
