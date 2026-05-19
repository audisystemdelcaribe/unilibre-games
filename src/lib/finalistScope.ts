export type EventForFinalist = {
    id: number;
    name: string;
    scope?: string;
    program_id?: number | null;
    faculty_id?: number | null;
    game_mode_id?: number;
    programs?: { id: number; name: string } | { id: number; name: string }[] | null;
};

export function getEventProgramInfo(evt: EventForFinalist | undefined): { programId: number; programName: string } | null {
    if (!evt || evt.scope !== 'program' || evt.program_id == null) return null;
    const prog = Array.isArray(evt.programs) ? evt.programs[0] : evt.programs;
    return {
        programId: Number(evt.program_id),
        programName: prog?.name ?? `Programa #${evt.program_id}`,
    };
}

/** Clave de agrupación y filtro: programa del evento (preselección), no del perfil del estudiante. */
export function getFinalistGroupKey(
    eventId: number,
    playerProgramId: number | null | undefined,
    eventMap: Map<number, EventForFinalist>
): { key: number; label: string } {
    const evt = eventMap.get(eventId);
    const fromEvent = getEventProgramInfo(evt);
    if (fromEvent) return { key: fromEvent.programId, label: fromEvent.programName };
    if (playerProgramId != null) {
        const prog = Array.isArray(evt?.programs) ? evt?.programs[0] : evt?.programs;
        return { key: playerProgramId, label: prog?.name ?? `Programa #${playerProgramId}` };
    }
    return { key: -1, label: 'Sin programa' };
}

export function eventMatchesProgramFilter(
    eventId: number,
    programId: number,
    eventMap: Map<number, EventForFinalist>
): boolean {
    const evt = eventMap.get(eventId);
    if (!evt) return false;
    if (evt.scope === 'program' && evt.program_id != null) {
        return Number(evt.program_id) === programId;
    }
    return false;
}
