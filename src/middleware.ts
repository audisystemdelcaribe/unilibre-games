import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { defineMiddleware } from "astro:middleware";
import { resolveAuthSession } from "./lib/authSession";

function shouldSkipAuth(pathname: string): boolean {
    return (
        pathname.startsWith("/_astro/") ||
        pathname.startsWith("/.well-known/") ||
        /\.(css|js|map|ico|svg|png|jpe?g|webp|gif|woff2?|ttf|mp3)$/i.test(pathname)
    );
}

export const onRequest = defineMiddleware(async (context, next) => {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        throw new Error("Faltan las variables de entorno de Supabase en .env");
    }

    context.locals.supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
            getAll() {
                return parseCookieHeader(context.request.headers.get("Cookie") ?? "");
            },
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value, options }) => {
                    context.cookies.set(name, value, options);
                });
            },
        },
    });

    const url = new URL(context.request.url);

    if (shouldSkipAuth(url.pathname)) {
        context.locals.user = null;
        context.locals.accessToken = null;
        context.locals.getUser = async () => null;
        return next();
    }

    const { user, accessToken } = await resolveAuthSession(context.locals.supabase);
    context.locals.user = user;
    context.locals.accessToken = accessToken;
    context.locals.getUser = async () => user;

    if (url.pathname.startsWith("/dashboard") && !user) {
        return context.redirect("/");
    }

    if (url.pathname === "/" && user) {
        return context.redirect("/dashboard");
    }

    return next();
});
