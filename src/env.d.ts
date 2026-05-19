/// <reference types="astro/client" />
declare namespace App {
    interface Locals {
        supabase: import("@supabase/supabase-js").SupabaseClient;
        user: import("@supabase/supabase-js").User | null;
        accessToken: string | null;
        getUser: () => Promise<import("@supabase/supabase-js").User | null>;
    }
}
