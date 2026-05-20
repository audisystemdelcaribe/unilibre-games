export type PreguntasListFilters = {
    tab?: string;
    search?: string;
    fSubject?: string;
    fLevel?: string;
    page?: string | number;
};

/** Serializa filtros del listado para conservarlos tras guardar/eliminar. */
export function buildPreguntasListQuery(filters: PreguntasListFilters): string {
    const params = new URLSearchParams();
    const tab = filters.tab === "resumen" ? "resumen" : "listado";
    params.set("tab", tab);
    if (filters.search?.trim()) params.set("search", filters.search.trim());
    if (filters.fSubject) params.set("fSubject", String(filters.fSubject));
    if (filters.fLevel) params.set("fLevel", String(filters.fLevel));
    const page = Number(filters.page);
    if (!isNaN(page) && page > 1) params.set("page", String(page));
    return params.toString();
}

export function preguntasListPath(queryString: string): string {
    return queryString ? `/dashboard/preguntas?${queryString}` : "/dashboard/preguntas?tab=listado";
}

/** Añade mensaje flash (toast) a la query de redirección tras una acción. */
export function preguntasListPathWithFlash(
    queryString: string,
    flash: { type: "success" | "error"; message: string },
    extra?: { savedId?: number; filtersCleared?: boolean }
): string {
    const params = new URLSearchParams(queryString || "tab=listado");
    params.set("flash", flash.message);
    params.set("flashType", flash.type);
    if (extra?.savedId) params.set("saved_id", String(extra.savedId));
    if (extra?.filtersCleared) params.set("filtros", "cleared");
    return preguntasListPath(params.toString());
}

/** Tras guardar: listado página 1 sin filtros de materia/nivel para que se vea la pregunta nueva. */
export function preguntasListPathAfterSave(
    returnQuery: string,
    flash: { type: "success" | "error"; message: string },
    savedId: number
): { path: string; filtersCleared: boolean } {
    const prev = parsePreguntasListQuery(returnQuery);
    const filtersCleared = !!(prev.fSubject || prev.fLevel || prev.search);

    const base = buildPreguntasListQuery({
        tab: "listado",
        search: "",
        fSubject: "",
        fLevel: "",
        page: 1,
    });

    return {
        path: preguntasListPathWithFlash(base, flash, {
            savedId,
            filtersCleared,
        }),
        filtersCleared,
    };
}

export function parsePreguntasListQuery(raw: string | null | undefined): PreguntasListFilters {
    if (!raw?.trim()) return { tab: "listado" };
    const params = new URLSearchParams(raw.trim());
    return {
        tab: params.get("tab") ?? "listado",
        search: params.get("search") ?? "",
        fSubject: params.get("fSubject") ?? "",
        fLevel: params.get("fLevel") ?? "",
        page: params.get("page") ?? "1",
    };
}
