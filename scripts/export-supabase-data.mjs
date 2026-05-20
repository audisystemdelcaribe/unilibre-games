/**
 * Exporta datos de Supabase a JSON (sin instalar Supabase CLI).
 *
 * Requisitos en .env (proyecto VIEJO o actual):
 *   PUBLIC_SUPABASE_URL=...
 *   SUPABASE_SECRET_KEY=...
 *
 * Uso:
 *   node scripts/export-supabase-data.mjs
 *   node scripts/export-supabase-data.mjs --out supabase/backup/mi-backup
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const TABLES_IN_ORDER = [
    "faculties",
    "programs",
    "subjects",
    "program_subjects",
    "seasons",
    "game_modes",
    "game_levels",
    "lifelines",
    "fastest_finger_sequences",
    "fastest_finger_items",
    "questions",
    "answers",
    "events",
    "event_rounds",
    "players",
    "event_players",
    "game_sessions",
    "game_answers",
    "round_questions_shown",
    "fastest_finger_rounds",
    "fastest_finger_attempts",
    "active_contestants",
    "round_lifeline_usage",
    "student_answer_selection",
    "audience_lifeline_votes",
    "season_rankings",
];

function loadEnv() {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
    }
}

async function fetchAll(supabase, table) {
    const pageSize = 1000;
    const rows = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase.from(table).select("*").range(from, from + pageSize - 1);
        if (error) throw new Error(`${table}: ${error.message}`);
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return rows;
}

async function exportAuthUsers(supabase, outDir) {
    const users = [];
    let page = 1;
    const perPage = 1000;

    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
        if (error) throw new Error(`auth.users: ${error.message}`);
        const batch = data?.users ?? [];
        users.push(
            ...batch.map((u) => ({
                id: u.id,
                email: u.email,
                user_metadata: u.user_metadata,
                created_at: u.created_at,
            }))
        );
        if (batch.length < perPage) break;
        page += 1;
    }

    const file = path.join(outDir, "auth_users.json");
    fs.writeFileSync(file, JSON.stringify(users, null, 2), "utf8");
    console.log(`  auth_users: ${users.length} filas → ${file}`);
    return users.length;
}

async function main() {
    loadEnv();

    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
        console.error("Faltan PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY en .env");
        process.exit(1);
    }

    const outArg = process.argv.indexOf("--out");
    const defaultDir = `supabase/backup/${new Date().toISOString().slice(0, 10)}`;
    const outDir = path.resolve(
        process.cwd(),
        outArg !== -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : defaultDir
    );
    fs.mkdirSync(outDir, { recursive: true });

    const supabase = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    console.log("Exportando desde:", url);
    console.log("Carpeta:", outDir);
    console.log("");

    const manifest = { exported_at: new Date().toISOString(), source_url: url, tables: {} };

    for (const table of TABLES_IN_ORDER) {
        try {
            const rows = await fetchAll(supabase, table);
            const file = path.join(outDir, `${table}.json`);
            fs.writeFileSync(file, JSON.stringify(rows, null, 2), "utf8");
            manifest.tables[table] = rows.length;
            console.log(`  ${table}: ${rows.length} filas`);
        } catch (e) {
            console.warn(`  ${table}: omitida (${e.message})`);
            manifest.tables[table] = `error: ${e.message}`;
        }
    }

    try {
        manifest.tables.auth_users = await exportAuthUsers(supabase, outDir);
    } catch (e) {
        console.warn(`  auth_users: omitida (${e.message})`);
        manifest.tables.auth_users = `error: ${e.message}`;
    }

    fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log("");
    console.log("Listo. Guarda esta carpeta y úsala para importar en el proyecto nuevo.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
