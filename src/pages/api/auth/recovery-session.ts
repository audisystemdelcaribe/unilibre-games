import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request, locals }) => {
    let body: { access_token?: string; refresh_token?: string };
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: "Datos inválidos" }), { status: 400 });
    }

    const access_token = body.access_token?.trim();
    const refresh_token = body.refresh_token?.trim();

    if (!access_token || !refresh_token) {
        return new Response(JSON.stringify({ error: "Faltan tokens" }), { status: 400 });
    }

    const { error } = await locals.supabase.auth.setSession({
        access_token,
        refresh_token,
    });

    if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
