import type { SupabaseClient } from "@supabase/supabase-js";
import { getProvisionalWinner, loadFastestFingerAttempts } from "./fastestFingerResults";

/** Metadatos guardados al crear cada ronda de Silla Caliente tras confirmar ganador de MMR. */
export type ClasicoRoundMeta = {
    contestant_player_id?: number;
    from_mmr_round_id?: number;
};

export function parseClasicoRoundMeta(verificationResult: unknown): ClasicoRoundMeta {
    if (!verificationResult || typeof verificationResult !== "object") return {};
    const o = verificationResult as Record<string, unknown>;
    const pid = o.contestant_player_id;
    const mmr = o.from_mmr_round_id;
    return {
        contestant_player_id:
            typeof pid === "number" ? pid : typeof pid === "string" ? parseInt(pid, 10) : undefined,
        from_mmr_round_id:
            typeof mmr === "number" ? mmr : typeof mmr === "string" ? parseInt(mmr, 10) : undefined,
    };
}

export function buildClasicoRoundMeta(playerId: number, fromMmrRoundId?: number): ClasicoRoundMeta {
    const meta: ClasicoRoundMeta = { contestant_player_id: playerId };
    if (fromMmrRoundId != null && fromMmrRoundId > 0) meta.from_mmr_round_id = fromMmrRoundId;
    return meta;
}

/** Conserva concursante/MMR al guardar resultado de una pregunta en la misma columna JSON. */
export function mergeClasicoRoundVerification(
    existing: unknown,
    answerPatch: Record<string, unknown>
): Record<string, unknown> {
    const base =
        existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};
    const merged: Record<string, unknown> = { ...base, ...answerPatch };
    const meta = parseClasicoRoundMeta(existing);
    const patchMeta = parseClasicoRoundMeta(answerPatch);
    const contestantId = meta.contestant_player_id ?? patchMeta.contestant_player_id;
    const mmrId = meta.from_mmr_round_id ?? patchMeta.from_mmr_round_id;
    if (contestantId != null) {
        merged.contestant_player_id = contestantId;
        if (mmrId != null) merged.from_mmr_round_id = mmrId;
    }
    return merged;
}

type ClasicoRoundInput = {
    id: number;
    verification_result: unknown;
};

/** Concursante autorizado para una ronda concreta de Silla Caliente (no solo el último del evento). */
export async function resolveContestantPlayerIdForClasicoRound(
    supabase: SupabaseClient,
    round: { id: number; event_id: number; verification_result: unknown },
    seasonId?: number | null
): Promise<number | null> {
    const meta = parseClasicoRoundMeta(round.verification_result);
    if (meta.contestant_player_id) return meta.contestant_player_id;

    const { data: ac } = await supabase
        .from("active_contestants")
        .select("player_id, round_id")
        .eq("event_id", round.event_id)
        .maybeSingle();

    if (ac?.round_id === round.id && ac.player_id) return ac.player_id;

    if (meta.from_mmr_round_id) {
        const mmrCache = new Map<number, number | null>();
        const pid = await winnerPlayerIdForMmrRound(supabase, meta.from_mmr_round_id, mmrCache);
        if (pid) return pid;
    }

    const activeMap = new Map<number, number>();
    if (ac?.round_id != null && ac.player_id) activeMap.set(ac.round_id, ac.player_id);

    const { data: eventRounds } = await supabase
        .from("event_rounds")
        .select("id, verification_result")
        .eq("event_id", round.event_id)
        .order("id", { ascending: true });

    const clasicoInputs: ClasicoRoundInput[] = (eventRounds || []).map((r) => ({
        id: r.id,
        verification_result: r.verification_result,
    }));

    const pidMap = await resolveContestantPlayerIdsForClasicoRounds(
        supabase,
        clasicoInputs.length ? clasicoInputs : [{ id: round.id, verification_result: round.verification_result }],
        activeMap,
        seasonId
    );
    return pidMap.get(round.id) ?? null;
}

async function resolveContestantPlayerIdsForClasicoRounds(
    supabase: SupabaseClient,
    clasicoRounds: ClasicoRoundInput[],
    activeContestantByRoundId: Map<number, number>,
    seasonId?: number | null
): Promise<Map<number, number>> {
    const pidByRound = new Map<number, number>();
    if (!clasicoRounds.length) return pidByRound;

    const mmrCache = new Map<number, number | null>();

    for (const r of clasicoRounds) {
        const meta = parseClasicoRoundMeta(r.verification_result);
        let pid =
            meta.contestant_player_id ??
            activeContestantByRoundId.get(r.id) ??
            null;

        if (!pid && meta.from_mmr_round_id) {
            pid = (await winnerPlayerIdForMmrRound(supabase, meta.from_mmr_round_id, mmrCache)) ?? null;
        }

        if (pid) pidByRound.set(r.id, pid);
    }

    const missing = clasicoRounds.filter((r) => !pidByRound.has(r.id)).sort((a, b) => a.id - b.id);
    if (missing.length > 0) {
        let mmrRoundIds: number[] = [];

        if (seasonId) {
            const { data: mmrEvents } = await supabase
                .from("events")
                .select("id")
                .eq("season_id", seasonId)
                .eq("game_mode_id", 3);
            const mmrEvIds = (mmrEvents || []).map((e: { id: number }) => e.id);
            if (mmrEvIds.length) {
                const { data: seasonRounds } = await supabase
                    .from("event_rounds")
                    .select("id")
                    .in("event_id", mmrEvIds)
                    .eq("status", "finished");
                mmrRoundIds = (seasonRounds || []).map((r: { id: number }) => r.id);
            }
        } else {
            const { data: ffRows } = await supabase
                .from("fastest_finger_rounds")
                .select("event_round_id");
            mmrRoundIds = (ffRows || []).map((f: { event_round_id: number }) => f.event_round_id);
        }

        mmrRoundIds.sort((a, b) => a - b);
        const zipWinners: number[] = [];
        for (const mmrId of mmrRoundIds) {
            const pid = await winnerPlayerIdForMmrRound(supabase, mmrId, mmrCache);
            if (pid) zipWinners.push(pid);
        }

        const allClasicoSorted = [...clasicoRounds].sort((a, b) => a.id - b.id);
        for (let i = 0; i < allClasicoSorted.length; i++) {
            const cr = allClasicoSorted[i];
            if (pidByRound.has(cr.id)) continue;
            const pid = zipWinners[i];
            if (pid) pidByRound.set(cr.id, pid);
        }
    }

    return pidByRound;
}

async function winnerPlayerIdForMmrRound(
    supabase: SupabaseClient,
    mmrRoundId: number,
    cache: Map<number, number | null>
): Promise<number | null> {
    if (cache.has(mmrRoundId)) return cache.get(mmrRoundId) ?? null;
    const { attempts } = await loadFastestFingerAttempts(supabase, mmrRoundId);
    const w = getProvisionalWinner(attempts);
    const pid = w?.player_id ?? null;
    cache.set(mmrRoundId, pid);
    return pid;
}

/**
 * Resuelve el nombre del concursante por ronda de Silla Caliente (una persona por sesión).
 */
export async function resolveContestantNamesForClasicoRounds(
    supabase: SupabaseClient,
    clasicoRounds: ClasicoRoundInput[],
    activeContestantByRoundId: Map<number, number>,
    seasonId?: number | null
): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    if (!clasicoRounds.length) return names;

    const pidByRound = await resolveContestantPlayerIdsForClasicoRounds(
        supabase,
        clasicoRounds,
        activeContestantByRoundId,
        seasonId
    );

    const playerIds = [...new Set(pidByRound.values())];
    if (!playerIds.length) return names;

    const { data: players } = await supabase
        .from("players")
        .select("id, name")
        .in("id", playerIds);

    const nameMap = new Map((players || []).map((p) => [p.id, p.name || "Estudiante"]));

    for (const [roundId, pid] of pidByRound) {
        names.set(roundId, nameMap.get(pid) || "Estudiante");
    }
    return names;
}
