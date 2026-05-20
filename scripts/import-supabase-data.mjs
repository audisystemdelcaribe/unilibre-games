/**
 * Importa JSON exportado por export-supabase-data.mjs al proyecto en .env.
 *
 * 1. Ejecuta full-database-restore.sql en el proyecto NUEVO.
 * 2. Pon en .env las keys del proyecto NUEVO.
 * 3. node scripts/import-supabase-data.mjs --from supabase/backup/2026-05-19
 *
 * Los usuarios Auth se recrean sin contraseña (hay que usar "Crear usuario" o reset password).
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

const UPSERT_CONFLICT = {
    faculties: "id",
    programs: "id",
    subjects: "id",
    program_subjects: "program_id,subject_id,semester",
    seasons: "id",
    game_modes: "id",
    game_levels: "id",
    lifelines: "id",
    fastest_finger_sequences: "id",
    fastest_finger_items: "id",
    questions: "id",
    answers: "id",
    events: "id",
    event_rounds: "id",
    players: "id",
    event_players: "event_id,player_id",
    game_sessions: "id",
    game_answers: "id",
    round_questions_shown: "id",
    fastest_finger_rounds: "id",
    fastest_finger_attempts: "id",
    active_contestants: "id",
    round_lifeline_usage: "id",
    student_answer_selection: "id",
    audience_lifeline_votes: "id",
    season_rankings: "id",
};

async function upsertBatches(supabase, table, rows, batchSize = 200) {
    const onConflict = UPSERT_CONFLICT[table];
    for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const opts = onConflict ? { onConflict } : {};
        const { error } = await supabase.from(table).upsert(chunk, opts);
        if (error) throw new Error(error.message);
    }
}

async function importAuthUsers(supabase, fromDir) {
    const file = path.join(fromDir, "auth_users.json");
    if (!fs.existsSync(file)) return;

    const users = JSON.parse(fs.readFileSync(file, "utf8"));
    let ok = 0;
    for (const u of users) {
        if (!u.email) continue;
        const { error } = await supabase.auth.admin.createUser({
            email: u.email,
            email_confirm: true,
            user_metadata: u.user_metadata ?? {},
        });
        if (error && !/already|exists|registered/i.test(error.message)) {
            console.warn(`    auth ${u.email}: ${error.message}`);
        } else {
            ok += 1;
        }
    }
    console.log(`  auth_users: ${ok}/${users.length} procesados (contraseñas: reset manual)`);
}

async function main() {
    loadEnv();

    const fromIdx = process.argv.indexOf("--from");
    if (fromIdx === -1 || !process.argv[fromIdx + 1]) {
        console.error("Uso: node scripts/import-supabase-data.mjs --from supabase/backup/FECHA");
        process.exit(1);
    }

    const fromDir = path.resolve(process.cwd(), process.argv[fromIdx + 1]);
    if (!fs.existsSync(fromDir)) {
        console.error("No existe la carpeta:", fromDir);
        process.exit(1);
    }

    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
        console.error("Faltan PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY en .env");
        process.exit(1);
    }

    const supabase = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    console.log("Importando a:", url);
    console.log("Desde:", fromDir);
    console.log("");

    console.log("Usuarios Auth (antes de players)...");
    await importAuthUsers(supabase, fromDir);
    console.log("");

    for (const table of TABLES_IN_ORDER) {
        const file = path.join(fromDir, `${table}.json`);
        if (!fs.existsSync(file)) {
            console.log(`  ${table}: sin archivo, omitida`);
            continue;
        }
        const rows = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!rows.length) {
            console.log(`  ${table}: 0 filas`);
            continue;
        }
        try {
            await upsertBatches(supabase, table, rows);
            console.log(`  ${table}: ${rows.length} filas`);
        } catch (e) {
            console.error(`  ${table}: ERROR ${e.message}`);
        }
    }

    console.log("");
    console.log("Listo. Asigna contraseñas (Crear usuario / reset) y rol admin si hace falta.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
