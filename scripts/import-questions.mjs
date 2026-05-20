/**
 * Importa preguntas desde JSON al banco (sin panel Supabase).
 *
 * 1. Edita o genera: supabase/import/preguntas.json (ver preguntas.ejemplo.json)
 * 2. .env con PUBLIC_SUPABASE_URL y SUPABASE_SECRET_KEY del proyecto
 * 3. node scripts/import-questions.mjs
 * 4. node scripts/import-questions.mjs --dry-run   (solo valida, no inserta)
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const DEFAULT_FILE = path.join(process.cwd(), "supabase", "import", "preguntas.json");

function loadEnv() {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
    }
}

async function nextId(supabase, table) {
    const { data, error } = await supabase
        .from(table)
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return (data?.id ?? 0) + 1;
}

async function resolveId(supabase, table, id, name, nameField = "name") {
    if (id != null && id !== "") return Number(id);
    if (!name?.trim()) return null;
    const { data, error } = await supabase.from(table).select("id").eq(nameField, name.trim()).limit(1).maybeSingle();
    if (error) throw error;
    if (!data?.id) throw new Error(`No se encontró ${table} con nombre "${name}"`);
    return data.id;
}

function normalizeAnswers(raw) {
    const list = raw?.answers ?? raw?.opciones ?? [];
    if (!Array.isArray(list) || list.length < 2) {
        throw new Error("Cada pregunta necesita al menos 2 respuestas en 'answers'");
    }
    return list.map((a, i) => {
        const text = (a.answer_text ?? a.text ?? a.texto ?? "").trim();
        if (!text) throw new Error(`Respuesta ${i + 1} vacía`);
        const correct =
            a.is_correct === true ||
            a.correct === true ||
            a.correcta === true ||
            String(a.is_correct ?? a.correct ?? a.correcta ?? "").toLowerCase() === "true";
        return { answer_text: text, is_correct: correct };
    });
}

function pickCorrectIndex(answers) {
    const n = answers.findIndex((a) => a.is_correct);
    if (n === -1) throw new Error("Marca una respuesta correcta (correct: true)");
    return n;
}

async function main() {
    loadEnv();
    const dryRun = process.argv.includes("--dry-run");
    const fileArg = process.argv.find((a) => a.startsWith("--file="));
    const file = fileArg ? fileArg.slice("--file=".length) : DEFAULT_FILE;

    if (!fs.existsSync(file)) {
        console.error(`No existe: ${file}`);
        console.error("Copia supabase/import/preguntas.ejemplo.json → preguntas.json y edítalo.");
        process.exit(1);
    }

    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
        console.error("Faltan PUBLIC_SUPABASE_URL y SUPABASE_SECRET_KEY en .env");
        process.exit(1);
    }

    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = payload.questions ?? payload.preguntas ?? payload;
    if (!Array.isArray(items)) {
        console.error("El JSON debe tener un array 'questions' o ser un array directo.");
        process.exit(1);
    }

    let qId = await nextId(supabase, "questions");
    let aId = await nextId(supabase, "answers");
    let ok = 0;
    let skip = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const num = i + 1;
        try {
            const text = (item.question_text ?? item.pregunta ?? item.texto ?? "").trim();
            if (text.length < 5) throw new Error("Enunciado muy corto (mín. 5 caracteres)");

            const subjectId = await resolveId(
                supabase,
                "subjects",
                item.subject_id,
                item.subject_name ?? item.asignatura ?? item.materia
            );
            const levelId = await resolveId(
                supabase,
                "game_levels",
                item.level_id,
                item.level_name ?? item.nivel
            );

            const scope = item.scope ?? item.ambito ?? "global";
            let facultyId = null;
            let programId = null;
            if (scope === "faculty") {
                facultyId = await resolveId(
                    supabase,
                    "faculties",
                    item.faculty_id,
                    item.faculty_name ?? item.facultad
                );
            } else if (scope === "program") {
                programId = await resolveId(
                    supabase,
                    "programs",
                    item.program_id,
                    item.program_name ?? item.programa
                );
            }

            const answers = normalizeAnswers(item);
            pickCorrectIndex(answers);

            const { data: dup } = await supabase
                .from("questions")
                .select("id")
                .eq("subject_id", subjectId)
                .eq("level_id", levelId)
                .eq("question_text", text)
                .maybeSingle();

            if (dup?.id) {
                console.warn(`[${num}] Omitida (ya existe nº ${dup.id}): ${text.slice(0, 50)}…`);
                skip++;
                continue;
            }

            const row = {
                id: qId,
                subject_id: subjectId,
                level_id: levelId,
                question_text: text,
                scope,
                faculty_id: facultyId,
                program_id: programId,
                min_semester: Number(item.min_semester ?? item.semestre_min ?? 1),
                max_semester: Number(item.max_semester ?? item.semestre_max ?? 10),
                active: item.active !== false,
            };

            if (dryRun) {
                console.log(`[${num}] OK (dry-run) → pregunta #${qId}: ${text.slice(0, 60)}…`);
                qId++;
                aId += answers.length;
                ok++;
                continue;
            }

            const { error: qErr } = await supabase.from("questions").insert([row]);
            if (qErr) throw qErr;

            const answerRows = answers.map((a) => ({
                id: aId++,
                question_id: qId,
                answer_text: a.answer_text,
                is_correct: a.is_correct,
            }));
            const { error: aErr } = await supabase.from("answers").insert(answerRows);
            if (aErr) throw aErr;

            console.log(`[${num}] Importada pregunta #${qId}`);
            qId++;
            ok++;
        } catch (e) {
            console.error(`[${num}] Error: ${e.message}`);
            process.exitCode = 1;
        }
    }

    console.log(`\nListo: ${ok} importadas, ${skip} omitidas (duplicadas)${dryRun ? " [dry-run]" : ""}.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
