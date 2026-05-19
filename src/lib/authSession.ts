import type { SupabaseClient, User } from '@supabase/supabase-js';

const REFRESH_TOKEN_ERRORS = new Set([
    'refresh_token_already_used',
    'invalid_refresh_token',
    'refresh_token_not_found',
]);

export function isRefreshTokenError(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    if (error.code && REFRESH_TOKEN_ERRORS.has(error.code)) return true;
    return /refresh token/i.test(error.message ?? '');
}

/**
 * Una sola resolución de sesión por request (evita refresh_token_already_used).
 */
export async function resolveAuthSession(supabase: SupabaseClient): Promise<{
    user: User | null;
    accessToken: string | null;
}> {
    try {
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error) {
            if (isRefreshTokenError(error)) {
                await supabase.auth.signOut();
            }
            return { user: null, accessToken: null };
        }

        const { data: { session } } = await supabase.auth.getSession();
        return { user: user ?? null, accessToken: session?.access_token ?? null };
    } catch (err) {
        const e = err as { code?: string; message?: string };
        if (isRefreshTokenError(e)) {
            try {
                await supabase.auth.signOut();
            } catch {
                /* ignore */
            }
        }
        return { user: null, accessToken: null };
    }
}
