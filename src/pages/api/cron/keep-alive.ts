import type { APIRoute } from "astro";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Ping diario a Supabase para mantener el proyecto activo (evita pausa por inactividad en plan gratuito).
 * Invocado por Vercel Cron o un servicio externo con el mismo Authorization header.
 *
 * Variables en Vercel / .env:
 *   CRON_SECRET — cadena larga aleatoria (Vercel la envía como Bearer en crons)
 */
export const GET: APIRoute = async ({ request }) => {
    const cronSecret = import.meta.env.CRON_SECRET;
    const isProd = import.meta.env.PROD;

    if (cronSecret) {
        const auth = request.headers.get("authorization");
        if (auth !== `Bearer ${cronSecret}`) {
            return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            });
        }
    } else if (isProd) {
        return new Response(
            JSON.stringify({
                ok: false,
                error: "CRON_SECRET no configurado. Añádelo en Variables de entorno del despliegue.",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }

    const started = Date.now();

    const { data, error } = await supabaseAdmin
        .from("seasons")
        .select("id")
        .limit(1)
        .maybeSingle();

    const elapsedMs = Date.now() - started;

    if (error) {
        return new Response(
            JSON.stringify({
                ok: false,
                error: error.message,
                elapsed_ms: elapsedMs,
            }),
            { status: 502, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response(
        JSON.stringify({
            ok: true,
            message: "Supabase respondió correctamente",
            sample: data?.id ?? null,
            elapsed_ms: elapsedMs,
            at: new Date().toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
    );
};
